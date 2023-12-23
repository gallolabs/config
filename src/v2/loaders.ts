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
// import { extname } from 'path'
// @ts-ignore
// import flat from 'flat'
// const flattenObject = flat.flatten
// import deepmerge from 'deepmerge'

export interface SourceLoader {
    load(): Promise<Object>
    watch?(abortSignal: AbortSignal): EventEmitter
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
        const fullPrefix = this.prefix
            ? this.prefix.toLowerCase() + (this.prefix.endsWith('_') ? '' : '_')
            : null

        const env: Record<string, any> = fullPrefix
            ? chain(process.env)
                .pickBy((_, key) => key.toLowerCase().startsWith(fullPrefix))
                .mapKeys((_, key) => key.substring(fullPrefix.length))
                .value()
            : process.env

        for (const key in env) {
              if(typeof env[key] === 'string' && (env[key] as string).startsWith('@include')) {
                env[key] = new IncludeToken((env[key] as string).split(' ').slice(1).join(' '))
            }
        }

        return this.resolve ? flatDictToDeepObject({data: env, delimiter: '_', schema: this.schema}) : env
    }
}

export class JsonFileLoader implements SourceLoader {
    protected filepath: string

    public constructor(_schema: any, filepath: string) {
        this.filepath = filepath
    }

    public async load(): Promise<Object> {
        const content = await readFile(this.filepath, {encoding: 'utf8'})
        return JSON.parse(content)
    }
}

export class IncludeToken {
    uri: string

    public constructor(uri: string) {
        this.uri = uri
    }

    public getUri() {
        return this.uri
    }
}

export class YamlFileLoader implements SourceLoader {
    protected filepath: string

    public constructor(_schema: any, filepath: string) {
        this.filepath = filepath
    }

    public async load(): Promise<Object> {
        const content = await readFile(this.filepath, {encoding: 'utf8'})

        const customTags: YAML.Tags = [
            {
              tag: '!include',
              resolve(uri: string) {
                return new IncludeToken(uri)
              }
            }
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

export class FileLoader implements SourceLoader {
    protected loader: SourceLoader
    protected path: string

    protected extLoaders: Record<string, (schema: SchemaObject, filepath: string) => SourceLoader> = {
        'env': (schema: SchemaObject, filepath: string) => new EnvFileLoader(schema, filepath),
        'json': (schema: SchemaObject, filepath: string) => new JsonFileLoader(schema, filepath),
        'yml': (schema: SchemaObject, filepath: string) => new YamlFileLoader(schema, filepath),
        'yaml': (schema: SchemaObject, filepath: string) => new YamlFileLoader(schema, filepath)
    }

    public constructor(schema: SchemaObject, path: string) {
        const ext = extname(path).substring(1)
        this.path = path

        const loaderFactory = this.extLoaders[ext]

        if (!loaderFactory) {
            throw new Error('Unhandled extension ' + ext)
        }
        this.loader = loaderFactory(schema, path)
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
        return this.loader.load()
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

export class EnvFileLoader implements SourceLoader {
    protected filepath: string
    protected schema: SchemaObject

    public constructor(schema: SchemaObject, filepath: string) {
        this.filepath = filepath
        this.schema = schema
    }

    public async load(): Promise<Object> {
        const content = await readFile(this.filepath, {encoding: 'utf8'})
        const env = parseEnvString(content.replace(/^\s*#.*/gm, '').replace(/\n/g, ' '))

        return flatDictToDeepObject({data: env, delimiter: '_', schema: this.schema})
    }
}

export class HttpLoader implements SourceLoader {
    protected url: string

    public constructor(url: string) {
        this.url = url
    }

    public async load(): Promise<Object> {
        return await got(this.url).json()
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

//CONFIG_PATH=myApp

// interface AggragateLoaderOptions {
//     mergePolicy: 'shallow' | 'deep' | 'path-set'
// }

// export class AggregateLoader implements SourceLoader {
//     protected loaders: SourceLoader[]
//     protected options: AggragateLoaderOptions

//     public constructor(loaders: SourceLoader[], options: AggragateLoaderOptions) {
//         this.loaders = loaders
//         this.options = options
//     }

//     public async load(schema: SchemaObject): Promise<Object> {
//         const objs = await Promise.all(this.loaders.map(loader => loader.load(schema)))

//         if (this.options.mergePolicy === 'shallow') {
//             return objs.reduce((obj, _obj) => ({...obj, ..._obj}), {})
//         }

//         if (this.options.mergePolicy === 'path-set') {
//             const obj = {}

//             objs.forEach(_obj => {
//                 const flatObj = flattenObject(_obj)
//                 each(flatObj, (v, path) => {
//                     set(obj, path, v)
//                 })
//             })
//         }

//         return objs.reduce((obj, _obj) => deepmerge(obj, _obj), {})
//     }
// }
