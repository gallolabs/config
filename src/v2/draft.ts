// @ts-nocheck
import fs, { existsSync } from 'fs'
import { mapKeys, pickBy, each, set, get, omit } from 'lodash-es'
import { extname, resolve, dirname } from 'path'
import { parseFile as parseYmlFile } from './yaml.js'
import fjp, {Operation} from 'fast-json-patch'
import chokidar from 'chokidar'
import { EventEmitter, once } from 'events'
import {SchemaObject, default as Ajv} from 'ajv'
import traverse from 'traverse'
const  { compare } = fjp
import { readFile } from 'fs/promises'
import parseEnvString from 'parse-env-string'

// adapted from https://github.com/sindresorhus/execa/blob/main/lib/promise.js
const nativePromisePrototype = (async () => {})().constructor.prototype;

const descriptors = ['then', 'catch', 'finally'].map(property => [
    property,
    Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property),
]) as [string, TypedPropertyDescriptor<any>][];

const mergePromise = (configLoader: ConfigLoader<any>, promise: Promise<any>): ConfigLoader<any> & Promise<any> => {
    for (const [property, descriptor] of descriptors) {
        const value = descriptor.value.bind(promise);

        Reflect.defineProperty(configLoader, property, {...descriptor, value});
    }

    return configLoader as ConfigLoader<any> & Promise<any>
};
// --------------------------------------------------------------------------

export function loadConfig<Config extends Object>(opts: ConfigLoaderOpts): ConfigLoader<Config> & Promise<any> {
    const loader = new ConfigLoader(opts)

    return mergePromise(loader, once(loader, 'loaded').then(v => v[0]))
}

export interface ConfigLoaderPlugin {
    load(configLoad: Object, schema: SchemaObject): Promise<Object>
}

export interface ConfigLoaderOpts {
    schema: SchemaObject
    plugins?: ConfigLoaderPlugin[]
    watchChanges?: boolean
}

export type ChangePatchOperation = Operation

export interface WatchChangesEventEmitter<Config> extends EventEmitter {
    on(event: 'change', listener: (arg: {patch: ChangePatchOperation[], config: Config, previousConfig: Config}) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: string, listener: (arg: {value: unknown, previousValue: unknown, config: Config, previousConfig: Config}) => void): this
}

export class ConfigLoader<Config extends Object> extends EventEmitter implements WatchChangesEventEmitter<Config> {
    protected plugins: ConfigLoaderPlugin[]
    protected schema: SchemaObject
    protected watchChanges: boolean
    protected running = false
    protected config?: Config

    public constructor(opts: ConfigLoaderOpts) {
        super()
        this.plugins = opts.plugins || [new EnvLoaderPlugin]
        this.schema = opts.schema
        this.watchChanges = opts.watchChanges || false
    }

    public start(abortSignal?: AbortSignal) {
        if (this.running) {
            throw new Error('Already running')
        }
        if (abortSignal?.aborted) {
            throw abortSignal.reason
        }
        abortSignal?.addEventListener('abort', () => this.stop())
        this.running = true

        this.load()
    }

    public stop() {
        if (!this.running) {
            return
        }
    }

    protected async load() {
        this.emit('load')

        let configLoad: Object = {}

        for(const plugin of this.plugins) {
            configLoad = await plugin.load(configLoad, this.schema)
        }

        let config: Config

        try {
            config = this.validate(configLoad)
        } catch (e) {
            this.emit('error')
            return
        }

        const previousConfig = config
        this.config = config
        this.emit('loaded', config)

        if (this.config) {
            this.emitChanges(previousConfig, config)
        }
    }

    protected emitChanges(previousConfig: Config, config: Config) {
        const patch = compare(previousConfig, config, false).map(op => {
            return {
                ...op,
                path: op.path
                    .replace(/^\//, '')
                    .replace(/\//g, '.')
                    //.replace(/\.([0-9]+)(\.|$)/g, '[$1]$2')
            }
        })

        if (patch.length === 0) {
            return
        }

        const changeArg = {
            patch,
            config,
            previousConfig
        }

        const hasGlobalChangeListener = this.emit('change', changeArg)
        patch.forEach(op => {
            let pathHasListener = false
            op.path.split('.').reduce((rootToLeafNodes: string[], node) => {
                rootToLeafNodes = rootToLeafNodes.concat(node)
                const nodeHasListener = this.emit('change:' + rootToLeafNodes.join('.') as 'change:xxx', {
                    config,
                    previousConfig,
                    value: get(config, rootToLeafNodes),
                    previousValue: get(previousConfig, rootToLeafNodes),
                })

                if (nodeHasListener) {
                    pathHasListener = true
                }

                return rootToLeafNodes
            }, [])

            if (!pathHasListener && !hasGlobalChangeListener) {
                this.emit('error', new Error('Unhandled config watch change for ' + op.path), 'watchChanges')
            }

        })
    }

    protected validate(candidateConfig: Object): Config {

        const schema =  {...this.schema, additionalProperties: false}

        // @ts-ignore
        const ajv = new Ajv({
            coerceTypes: true,
            removeAdditional: true,
            useDefaults: true,
            strict: true
        })

        if (!ajv.validate(schema, candidateConfig)) {
            const firstError = ajv.errors![0]
            const message = 'Configuration '
                + (firstError.instancePath ? firstError.instancePath.substring(1).replace('/', '.') + ' ' : '')
                + firstError.message

            throw new Error(message)
        }

        return candidateConfig as Config
    }
}

interface FileLoaderContentParser {
    isFlat: () => boolean
    parse: (content: string) => Promise<Object> | Object
}

class JsonFileParser implements FileLoaderContentParser {
    public isFlat() {
        return false
    }
    public parse(content: string): Object {
        return JSON.parse(content)
    }
}

class YamlFileParser implements FileLoaderContentParser {
    public isFlat() {
        return false
    }
    public parse(content: string): Object {
        return JSON.parse(content)
    }
}

class EnvFileParser implements FileLoaderContentParser {
    protected delimiter: string = '_'

    public isFlat() {
        return true
    }
    public parse(content: string): Object {
        // TODO try to deduce like EnvPlugin the good path
        return mapKeys(
            parseEnvString(content.replace(/\n/g, ' ')),
            (_value, key) => {
                return key.split(this.delimiter).join('.')
            }
        )
    }
}

export class FileLoaderPlugin implements ConfigLoaderPlugin {
    protected defaultFilePath?: string
    protected envFilePath?: string
    protected parsers: Record<string, FileLoaderContentParser> = {
        'json': new JsonFileParser,
        'yaml': new YamlFileParser,
        'yml': new YamlFileParser,
        'env': new EnvFileParser
    }

    async load(configLoad: Object): Promise<Object> {
        let filepath = this.defaultFilePath

        if (this.envFilePath && process.env[this.envFilePath]) {
            filepath = process.env[this.envFilePath]
        }

        if (!filepath) {
            return configLoad
        }

        // Ignore if no file available on default
        if (!existsSync(filepath) && filepath === this.defaultFilePath) {
            return configLoad
        }
        // -----------

        const content = await readFile(filepath, {encoding: 'utf8'})

        const parser = this.parsers[extname(filepath)]

        if (!parser) {
            throw new Error('Unhandled file type ' + filepath)
        }

        const parsed = parser.parse(content)

        if (parser.isFlat()) {
            each(parsed, (value, key) => {
                set(configLoad, key, value)
            })
            return configLoad
        }

        return {
            ...configLoad,
            ...parsed
        }
    }
}

export class EnvLoaderPlugin implements ConfigLoaderPlugin {
    protected delimiter: string
    protected prefix?: string

    public constructor({delimiter = '_', prefix}: {delimiter?: string, prefix?: string} = {}) {
        this.delimiter = delimiter
        this.prefix = prefix
    }

    async load(configLoad: Object, schema: SchemaObject): Promise<Object> {
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

        function findGoodPath(userPath: string, schema: SchemaObject) {
          const correctPath = []
          let cursor = schema

          for (const pathNode of userPath.split('.')) {

            const [, key, arrI] = pathNode.match(/([^\[]+)(\[[0-9]?\])?/) || [, pathNode]

            if (cursor.type === 'object') {
              const targetK = Object.keys(cursor.properties).find(k => k.toLowerCase() === key.toLowerCase())

              if (!targetK) {
                return
              }

              if (arrI && cursor.properties[targetK].items) {
                cursor = cursor.properties[targetK].items
                correctPath.push(targetK + arrI)
              } else {
                cursor = cursor.properties[targetK]
                correctPath.push(targetK)
              }

            }
          }

          return correctPath.join('.')
        }


        function extractEnvConfigPathsValues({delimiter, prefix, schema}: {delimiter: string, prefix?: string, schema: SchemaObject}): Record<string, string> {
            const fullPrefix = prefix ? prefix.toLowerCase() + (prefix.endsWith(delimiter) ? '' : delimiter) : null
            schema = unrefSchema(schema)
            const envs = (!fullPrefix ? process.env : mapKeys(
                pickBy(process.env, (_value, key) => key.toLowerCase().startsWith(fullPrefix)),
                (_v, k) => k?.substring(fullPrefix.length))
            ) as Record<string, string>
            // If prefix add warn if not found good path ?

            return mapKeys(envs, (_value, key) => {
                return findGoodPath(key.split(delimiter).join('.'), schema)
            })
        }

        const userEnvProvidedConfig = extractEnvConfigPathsValues({
            delimiter: this.delimiter,
            prefix: this.prefix,
            schema
        })

        each(userEnvProvidedConfig, (value, key) => {
            set(configLoad, key, value)
        })

        return configLoad
    }
}
















export interface ConfigOpts<Config> {
    schema: SchemaObject
    defaultFilename?: string
    envFilename?: string
    envPrefix?: string
    envDelimiter?: string
    watchChanges?: {
        abortSignal?: AbortSignal
        eventEmitter: WatchChangesEventEmitter<Config>
    }
}




export async function previousLoadConfig<Config extends object>(opts: ConfigOpts<Config>): Promise<Config> {
    let configInProgress: Partial<Config> = {}
    let filename = opts.defaultFilename
    const readFilenames: string[] = []

    if (opts.envFilename && process.env[opts.envFilename]) {
        filename = process.env[opts.envFilename]
    }

    if (filename) {
        const exists = existsSync(filename)

        if (!exists && filename !== opts.defaultFilename) {
            throw new Error('Unable to find ' + filename)
        }

        if (exists) {
            switch(extname(filename)) {
                case '.yml':
                case '.yaml':
                    configInProgress = await parseYmlFile(filename, { onFileRead: (f) => readFilenames.push(f) })
                    break
                case '.json':
                    configInProgress = JSON.parse(fs.readFileSync(filename, 'utf8'))
                    break
                case '.js':
                    configInProgress = require(resolve(filename))
                    break
                case '.env':
                    // Sorry, but I always use Docker, and it does it for me
                default:
                    throw new Error('Unhandled file type')
            }
        }
    }

    let configSchema = opts.schema

    const userEnvProvidedConfig = extractEnvConfigPathsValues({
        delimiter: opts.envDelimiter || '_',
        prefix: opts.envPrefix,
        schema: configSchema
    })

    each(userEnvProvidedConfig, (value, key) => {
        set(configInProgress, key, value)
    })

    let config: Config = validate(configInProgress, {
        schema: {...configSchema, additionalProperties: false},
        removeAdditional: true,
        contextErrorMsg: 'Configuration'
    }) as Config

    if (opts.watchChanges && filename) {

        const handleError = (error: Error, _context: string) =>  {
            opts.watchChanges!.eventEmitter.emit('error', error)
        }

        const watcher = chokidar.watch(readFilenames.length > 0 ? readFilenames : filename)
        .on('all', async () => {
            let newConfig: Config

            try {
                newConfig = await loadConfig({...opts, watchChanges: undefined})
            } catch (error) {
                handleError(error as Error, 'watch reload')
                return
            }
            const patch = compare(config, newConfig, false).map(op => {
                return {
                    ...op,
                    path: op.path
                        .replace(/^\//, '')
                        .replace(/\//g, '.')
                        //.replace(/\.([0-9]+)(\.|$)/g, '[$1]$2')
                }
            })

            if (patch.length === 0) {
                return
            }

            const previousConfig = config
            config = newConfig

            const changeArg = {
                patch,
                config,
                previousConfig
            }

            const hasGlobalChangeListener = opts.watchChanges!.eventEmitter!.emit('change', changeArg)
            patch.forEach(op => {
                let pathHasListener = false
                op.path.split('.').reduce((rootToLeafNodes: string[], node) => {
                    rootToLeafNodes = rootToLeafNodes.concat(node)
                    const nodeHasListener = opts.watchChanges!.eventEmitter!.emit('change:' + rootToLeafNodes.join('.') as 'change:xxx', {
                        config,
                        previousConfig,
                        value: get(config, rootToLeafNodes),
                        previousValue: get(previousConfig, rootToLeafNodes),
                    })

                    if (nodeHasListener) {
                        pathHasListener = true
                    }

                    return rootToLeafNodes
                }, [])

                if (!pathHasListener && !hasGlobalChangeListener) {
                    handleError(new Error('Unhandled config watch change for ' + op.path), 'watchChanges')
                }

            })
        })
        .on('error', (error) => handleError(error as Error, 'watch'))

        opts.watchChanges.abortSignal?.addEventListener('abort', () => {
            watcher.close().catch(error => handleError(error as Error, 'watch close'))
        })
    }

    return config
}
