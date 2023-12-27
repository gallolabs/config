import { cloneDeep, each, get, set } from 'lodash-es'
import fjp, {Operation} from 'fast-json-patch'
import { EventEmitter, once } from 'events'
import {SchemaObject, default as Ajv} from 'ajv'
import { RefResolver } from './ref-resolver.js'
const  { compare } = fjp
import {flatten} from 'uni-flatten'
//import addFormats from "ajv-formats"
//import ajvKeywords from 'ajv-keywords'

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

export function loadConfig<Config extends Object>(opts: ConfigLoaderOpts & {abortSignal?: AbortSignal}): ConfigLoader<Config> & Promise<Config> {
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
    protected running = false
    protected config?: Config
    protected refResolver: RefResolver
    protected needReload = false
    protected loading = false
    protected envPrefix?: string

    public constructor(opts: ConfigLoaderOpts) {
        super()
        this.schema = opts.schema
        this.refResolver = new RefResolver({
            supportWatchChanges: opts.supportWatchChanges ?? false
        })
        this.envPrefix = opts.envPrefix
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

        this.needReload = false

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
        let candidate: Object

        try {
            candidate = await this.__load()
        } catch (e) {
            this.emit('error', e)
            return
        }

        this.emit('candidate-loaded', candidate)

        let config: Config

        try {
            config = this.validate(candidate)
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

    protected mergeWithPaths(obj1: object, obj2: object): object {
        obj1 = cloneDeep(obj1)
        obj2 = cloneDeep(obj2)

        each(flatten(obj2 as any), (v, path) => {
            if (v === undefined) {
                return
            }
            set(obj1, path, v)
        })

        return obj1
    }

    protected async __load(): Promise<object> {
        this.refResolver.clear()

        const env = await this.refResolver.resolve('env:', { unflat: true, schema: this.schema, prefix: this.envPrefix })
        const arg = await this.refResolver.resolve('arg:', { unflat: true, schema: this.schema })

        let conf = this.mergeWithPaths(env, arg)

        if ((conf as any).config) {
            conf = (conf as any).config
            conf = this.mergeWithPaths(conf, env)
            conf = this.mergeWithPaths(conf, arg)
        }

        return conf
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
            strict: true,
            parseDate: true,
            allowDate: true
        })

        //addFormats.default(ajv)
        // ajvKeywords.default(ajv)

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
