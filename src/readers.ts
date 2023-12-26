import { readFile /*, readdir*/ } from "fs/promises"
import {chain} from 'lodash-es'
import {type SchemaObject} from 'ajv'
import minimist from 'minimist'
import got from 'got'
import { extname } from "path"
import chokidar from 'chokidar'
import EventEmitter from "events"
import isBinaryPath from "is-binary-path"
import { ContentParser, EnvParser, JsonParser, YamlParser } from "./parsers.js"
import { flatDictToDeepObject } from "./unflat-mapper.js"
import { QueryToken, createIncludeTokenFromString } from "./tokens.js"



export interface ReaderFactory<TReader extends Reader> {
    canRead: (uriWithoutFragment: string) => Promise<boolean>
    create: (uri: string, opts: object) => TReader
}

export interface Reader {
    read(): Promise<Object>
    watch?(abortSignal: AbortSignal): EventEmitter
    resolveUri?(uriWithoutFragment: string): string
}

export const builtinReaderFactories:ReaderFactory<any>[] = [
//    new ProcessArgvReaderFactory
]


export class ProcessArgvReaderFactory implements ReaderFactory<ProcessArgvReader> {
    public async canRead(uriWithoutFragment: string) {
        return uriWithoutFragment.startsWith('arg:')
    }
    public create(uri: string, opts: object) {
        return new ProcessArgvReader(null as any, false)
    }
}

export class ProcessArgvReader implements Reader {
    protected schema: SchemaObject
    protected resolve: boolean

    public constructor(schema: SchemaObject, resolve = true) {
        this.schema = schema
        this.resolve = resolve
    }

    public async read(): Promise<Object> {
        const args = minimist(process.argv)
        // @ts-ignore
        delete args._

        return this.resolve
            ? flatDictToDeepObject({data: args, delimiter: '-', schema: this.schema})
            : args
    }
}


export class ProcessEnvReader implements Reader {
    protected prefix?: string
    protected resolve: boolean
    protected schema: SchemaObject

    public constructor({prefix, resolve, schema}: {prefix?: string, resolve?: boolean, schema: SchemaObject}) {
        this.prefix = prefix
        this.resolve = resolve === undefined ? true : resolve
        this.schema = schema
    }

    public async load(): Promise<Object> {
        // Todo move to globalLoader
        const fullPrefix = this.prefix
            ? this.prefix.toLowerCase() + (this.prefix.endsWith('_') ? '' : '_')
            : null

        const env: Record<string, any> = fullPrefix
            ? chain(process.env)
                .pickBy((_, key) => key.toLowerCase().startsWith(fullPrefix))
                .mapKeys((_, key) => key.substring(fullPrefix.length))
                .value()
            : process.env
// Todo move to parser
        for (const key in env) {
            if(typeof env[key] === 'string' && (env[key] as string).startsWith('@ref')) {
                env[key] = createIncludeTokenFromString((env[key] as string).split(' ').slice(1).join(' '))
            }
            if(typeof env[key] === 'string' && (env[key] as string).startsWith('@query')) {
                env[key] = new QueryToken((env[key] as string).split(' ').slice(1).join(' '))
            }
        }
        // Todo move to globalLoader
        return this.resolve ? flatDictToDeepObject({data: env, delimiter: '_', schema: this.schema}) : env
    }
}


export class FileReader implements Reader {
    protected parser?: ContentParser
    protected path: string

    protected extParsers: Record<string, (schema: SchemaObject) => ContentParser> = {
        'env': (schema: SchemaObject) => new EnvParser(schema),
        'json': () => new JsonParser(),
        'yml': () => new YamlParser(),
        'yaml': () => new YamlParser()
    }

    public constructor(schema: SchemaObject, path: string) {
        const ext = extname(path).substring(1)
        this.path = path

        let parserFactory = this.extParsers[ext]

        this.parser = parserFactory ? parserFactory(schema) : undefined
    }

    public watch(abortSignal: AbortSignal) {

        const em = new EventEmitter

        const watcher = chokidar
            .watch(this.path)
            .on('all', async(type) => {
                if (type === 'add') {
                    return
                }
                em.emit('change')
            })
            .on('error', (error) => em.emit('error', error))

        abortSignal.addEventListener('abort', () => {
            watcher.close().catch((error) => em.emit('error', error))
        })

        return em
    }

    public async load(): Promise<Object> {
        if (!this.parser && isBinaryPath(this.path)) {
            return 'data:mimetypetodo;base64,' +  (await readFile(this.path)).toString('base64')
        }

        const content = await readFile(this.path, {encoding: 'utf8'})

        return this.parser ? this.parser.parse(content) : content
    }
}

// export class DirLoader implements SourceLoader {
//     protected dirpath: string

//     public constructor(dirpath: string) {
//         this.dirpath = dirpath
//     }

//     public async load(schema: SchemaObject): Promise<Object> {
//         const files = await readdir(this.dirpath)

//         const loaders = files.map(file => new FileLoader(file))

//         const objs = await Promise.all(loaders.map(loader => loader.load(schema)))

//         return objs.reduce((obj, _obj) => ({...obj, ..._obj}), {})
//     }
// }


export class HttpReader implements Reader {
    protected url: string
    protected schema: SchemaObject
    protected opts: object

    protected mimeParsers: Record<string, (schema: SchemaObject) => ContentParser> = {
        'text/plain': (schema: SchemaObject) => new EnvParser(schema),
        'application/json': () => new JsonParser(),
        'application/yaml': () => new YamlParser()
    }

    public constructor(url: string, schema: SchemaObject, opts?: object) {
        this.url = url
        this.schema = schema
        this.opts = opts || {}
    }

    public async load(): Promise<Object> {
        const res = await got(this.url)

        const contentType = res.headers['content-type']
            ? res.headers['content-type']
            : 'text/plain'

        const mimeType = contentType.split(';')[0].trim()

        const parserFactory = this.mimeParsers[mimeType]

        if (!parserFactory) {
            throw new Error('Unhandled type ' + mimeType)
        }

        const parser = parserFactory(this.schema)

        return parser.parse(res.body)
    }

    public watch(abortSignal: AbortSignal) {

        const em = new EventEmitter

        ;(async() => {
            let content = await got(this.url).text()

            const nodeTimeout = setInterval(async () => {
                try {
                    const newContent = await got(this.url).text()

                    if (newContent !== content) {
                        em.emit('change')
                    }

                    content = newContent
                } catch (e) {
                    em.emit('error', e)
                }
            }, (this.opts as any).watchInterval || 60000)

            abortSignal.addEventListener('abort', () => {
                clearInterval(nodeTimeout)
            })
        })()

        return em
    }
}
