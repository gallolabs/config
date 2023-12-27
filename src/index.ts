import { each, set, findKey, mapKeys, cloneDeep, get } from 'lodash-es'
import fjp, {Operation} from 'fast-json-patch'
import { EventEmitter, once } from 'events'
import {SchemaObject, default as Ajv} from 'ajv'
import { RefResolver } from './ref-resolver.js'
const  { compare } = fjp
import {flatten} from 'uni-flatten'
import { ProcessArgvLoader, ProcessEnvLoader } from './readers.js'

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

export type ChangePatchOperation = Operation

export interface WatchChangesEventEmitter<Config> extends EventEmitter {
    on(event: 'change', listener: (arg: {patch: ChangePatchOperation[], config: Config, previousConfig: Config}) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: string, listener: (arg: {value: unknown, previousValue: unknown, config: Config, previousConfig: Config}) => void): this
}

export function loadConfig<Config extends Object>(opts: ConfigLoaderOpts & {abortSignal?: AbortSignal}): ConfigLoader<Config> & Promise<any> {
    const loader = new ConfigLoader<Config>(opts)

    loader.start(opts.abortSignal)

    return mergePromise(loader, once(loader, 'loaded').then(v => v[0]))
}

export interface ConfigLoaderPlugin {
    load(configLoad: Object, schema: SchemaObject): Promise<Object>
}

export interface ConfigLoaderOpts {
    schema: SchemaObject
    envPrefix?: string
    supportWatchChanges?: boolean
}

export class ConfigError extends Error {
    name = 'ConfigError'
    config?: Object
    constructor(message: string, options: ErrorOptions & {config?: Object}) {
        super(message, {cause: options.cause})
        this.config = options.config
    }
}

export class ConfigLoader<Config extends Object> extends EventEmitter implements WatchChangesEventEmitter<Config> {
    protected schema: SchemaObject
    protected supportWatchChanges: boolean
    protected running = false
    protected config?: Config
    protected refResolver: RefResolver
    protected needReload = false
    protected loading = false

    public constructor(opts: ConfigLoaderOpts) {
        super()
        this.schema = opts.schema
        this.supportWatchChanges = opts.supportWatchChanges || false
        this.refResolver = new RefResolver({})
    }

    public start(abortSignal?: AbortSignal) {
        if (this.running) {
            throw new Error('Already running')
        }
        if (abortSignal?.aborted) {
            return
        }
        abortSignal?.addEventListener('abort', () => this.stop())
        this.running = true

        this.refResolver.on('stale', () => {
            this.load()
        })
        this.refResolver.on('error', (error) => this.emit('error', error))

        this.load()
    }

    protected stop() {
        if (!this.running) {
            return
        }

        this.refResolver.clear()

        this.running = false
    }

    // Avoid loading concurrency, but keep in mind we wanted it
    protected async load() {
        if (this.loading) {
            this.needReload = true
            return
        }

        this.needReload = false
        this.loading = true
        await this._load()
        this.loading = false

        if (this.needReload) {
            this.load()
        }
    }

    protected async _load() {
        this.emit('load')

        let configLoad: Object = await this.__load()

        let config: Config

        try {
            config = this.validate(configLoad)
        } catch (e) {
            this.emit('error', e)
            return
        }

        const previousConfig = this.config
        this.config = config
        this.emit('loaded', config)

        if (previousConfig) {
            this.emitChanges(previousConfig, config)
        }
    }

    protected async __load() {
        this.loaders = {
            env: new ProcessEnvLoader({ resolve: true, prefix: envPrefix, schema }),
            arg: new ProcessArgvLoader(schema, true)
        }

        this.refResolver.clear()
        const baseConfigs = await Promise.all([
            this.uriLoader.resolveTokens(await this.loaders.env.load(), 'env:'),
            this.uriLoader.resolveTokens(await this.loaders.arg.load(), 'arg:')
        ])

        const obj: Record<string, any> = cloneDeep(baseConfigs[0])

        each(flatten(baseConfigs[1] as any), (v, path) => {
            if (v === undefined) {
                return
            }
            set(obj, path, v)
        })


        const configKey = findKey(obj, (_, k) => k.toLowerCase() === 'config')

        if (configKey) {
            const config = mapKeys(obj[configKey], (_, k) => k.toLowerCase())
            if (config.uri) {
                const pathLoadedObj = await this.uriLoader.load(config.uri, config.opts, new FileParent('file://' + process.cwd))

                Object.assign(obj, pathLoadedObj)

                each(flatten(baseConfigs[0] as any), (v, path) => {
                    if (v === undefined) {
                        return
                    }
                    set(obj, path, v)
                })

                each(flatten(baseConfigs[1] as any), (v, path) => {
                    if (v === undefined) {
                        return
                    }
                    set(obj, path, v)
                })

            }
        }

        return obj
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

            throw new ConfigError(message, {
                config: candidateConfig,
                cause: ajv.errors![0]
            })
        }

        return candidateConfig as Config
    }
}
