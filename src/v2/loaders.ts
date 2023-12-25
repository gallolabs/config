import { readFile /*, readdir*/ } from "fs/promises"
import parseEnvString from 'parse-env-string'
import {each, set, omit, get, chain} from 'lodash-es'
import traverse from 'traverse'
import {type SchemaObject} from 'ajv'
import minimist from 'minimist'
import YAML from 'yaml'
import got from 'got'
import { extname } from "path"
import chokidar from 'chokidar'
import EventEmitter from "events"
import isBinaryPath from "is-binary-path"
// import { extname } from 'path'
// @ts-ignore
// import flat from 'flat'
// const flattenObject = flat.flatten
// import deepmerge from 'deepmerge'

export interface SourceLoader {
    load(): Promise<Object>
    watch?(abortSignal: AbortSignal): EventEmitter
}

export class IncludeToken {
    uri: string
    opts: object

    public constructor(uri: string, opts?: object) {
        this.uri = uri
        this.opts = opts || {}
    }

    public getUri() {
        return this.uri
    }

    public getOpts() {
        return this.opts
    }
}

export function createIncludeTokenFromString(string: string) {
    // let uriWithoutFragmentPart: string = ''
    // let fragmentPart: string = ''
    // let optsPart: string = ''

    // let step: 'uwfp' | 'fp' | 'op'  = 'uwfp'

    // for (let letter in string) {
    //     switch(step) {
    //         case 'uwfp':
    //             if (letter === '#') {
    //                 step = 'fp'
    //             } else if (letter === ' ') {
    //                 step = 'op'
    //             } else {
    //                 uriWithoutFragmentPart+= letter
    //             }
    //             break
    //         case 'fp':
    //             if (letter === ' ' && fragmentPart.startsWith())
    //     }

    // }

    const [uri, ...optsParts] = string.split(' ')

    const opts = optsParts.length ? JSON.parse(optsParts.join(' ')) : {} // jsonata(optsParts.join(' ')).evaluate(null)
    return new IncludeToken(uri, opts)

}

export function createIncludeTokenFromObject(obj: Record<string, any>) {
    if (!obj.uri) {
        throw new Error('Missing uri')
    }
    return new IncludeToken(obj.uri, obj.opts)
}

export class QueryToken {
    query: string

    public constructor(query: string) {
        this.query = query
    }

    public getQuery() {
        return this.query
    }
}


export class ProcessArgvLoader implements SourceLoader {
    protected schema: SchemaObject
    protected resolve: boolean

    public constructor(schema: SchemaObject, resolve = true) {
        this.schema = schema
        this.resolve = resolve
    }

    public async load(): Promise<Object> {
        const args = minimist(process.argv)
        // @ts-ignore
        delete args._

        return this.resolve
            ? flatDictToDeepObject({data: args, delimiter: '-', schema: this.schema})
            : args
    }
}

export class ProcessEnvLoader implements SourceLoader {
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

interface SourceParser {
    parse: (content: string) => Promise<Object>
}

export class JsonParser implements SourceParser {
    public async parse(content: string): Promise<Object> {
        return JSON.parse(content)
    }
}

export class YamlParser implements SourceParser {
    public async parse(content: string): Promise<Object> {
        const customTags: YAML.Tags = [
            {
              tag: '!ref',
              resolve(uri: string) {
                return new IncludeToken(uri)
              }
            },
            {
              tag: '!query',
              resolve(query: string) {
                return new QueryToken(query)
              }
            },
            {
              tag: '!ref',
              collection: 'map',
              resolve(obj: any) {
                obj = obj.toJSON()
                return new IncludeToken(obj.uri, obj.opts)
              }
            },
        ]

        const doc = YAML.parseDocument(
            content,
            { customTags }
        )

        const warnOrErrors = doc.errors.concat(doc.warnings)

        if (warnOrErrors.length) {
            throw warnOrErrors[0]
        }

        return doc.toJS()
    }
}

export class EnvParser implements SourceParser {
    protected schema: SchemaObject

    public constructor(schema: SchemaObject) {
        this.schema = schema
    }

    public async parse(content: string): Promise<Object> {
        const env = parseEnvString(content.replace(/^\s*#.*/gm, '').replace(/\n/g, ' '))

        return flatDictToDeepObject({data: env, delimiter: '_', schema: this.schema})
    }
}

export class FileLoader implements SourceLoader {
    protected parser?: SourceParser
    protected path: string

    protected extParsers: Record<string, (schema: SchemaObject) => SourceParser> = {
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


export class HttpLoader implements SourceLoader {
    protected url: string
    protected schema: SchemaObject
    protected opts: object

    protected mimeParsers: Record<string, (schema: SchemaObject) => SourceParser> = {
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

function flatDictToDeepObject({data, delimiter, schema}: {data: Record<string, any>, delimiter: string, schema: SchemaObject}) {

    const obj = {}
    schema = unrefSchema(schema)

    each(data, (value, key) => {
        const path = resolveFlatPath(key, delimiter, schema)
        set(obj, path, value)
    })

    return obj
}

function resolveFlatPath(path: string, delimiter: string, schema: any): string {

    if (schema.type === 'object') {
        const properties = schema.properties

        for (const propKey in properties) {
            if (propKey.toLowerCase() === path.substring(0, propKey.length).toLowerCase()) {
                const consumedPath = path.substring(propKey.length)
                if (consumedPath.length === 0 || consumedPath.substring(0, delimiter.length) === delimiter) {
                    const resolvedNext = resolveFlatPath(consumedPath.substring(delimiter.length), delimiter, properties[propKey])
                    return propKey + (resolvedNext ? '.' + resolvedNext : '')
                }
            }
        }

        if (typeof schema.additionalProperties === 'object') {
            const key = path.split(delimiter)[0]
            const resolvedNext = resolveFlatPath(path.substring(key.length + delimiter.length), delimiter, schema.additionalProperties)
            return key + (resolvedNext ? '.' + resolvedNext : '')
        }
    }

    if (schema.type === 'array') {
        const index = path.split(delimiter)[0]
        const resolvedNext = resolveFlatPath(path.substring(index.length + delimiter.length), delimiter, schema.items)
        return index + (resolvedNext ? '.' + resolvedNext : '')
    }

    return path.split(delimiter).join('.')
}

function unrefSchema(schema: Object) {
    function resolveRef(o: any): any {
        if (!(o instanceof Object && o.$ref)) {
            return o
        }
        const $ref = o.$ref
        if ($ref.substring(0, 1) !== '#') {
            throw new Error('Unexpected external resource')
        }
        const path = $ref.substring(2).replace(/\//g, '.')
        return {
            ...omit(o, '$ref'),
            ...resolveRef(get(schema, path))
        }
    }

    const resolved = traverse(schema).map(resolveRef)
    delete resolved.definitions

    return resolved
}
