import { get } from 'lodash-es'
import fjp, {Operation} from 'fast-json-patch'
import { EventEmitter, once } from 'events'
import {SchemaObject, default as Ajv} from 'ajv'
import { GlobalLoader, UriLoader } from './global-loader.js'
const  { compare } = fjp

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
    const loader = new ConfigLoader(opts)

    loader.start(opts.abortSignal)

    return mergePromise(loader, once(loader, 'loaded').then(v => v[0]))
}

export interface ConfigLoaderPlugin {
    load(configLoad: Object, schema: SchemaObject): Promise<Object>
}

export interface ConfigLoaderOpts {
    schema: SchemaObject
    envPrefix?: string
    watchChanges?: boolean
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
    protected watchChanges: boolean
    protected running = false
    protected config?: Config
    protected globalLoader: GlobalLoader
    protected uriLoader: UriLoader

    public constructor(opts: ConfigLoaderOpts) {
        super()
        this.schema = opts.schema
        this.watchChanges = opts.watchChanges || false
        this.globalLoader = new GlobalLoader({
            envPrefix: opts.envPrefix,
            schema: this.schema,
            uriLoader: this.uriLoader = new UriLoader(this.schema, this.watchChanges)
        })
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

        this.uriLoader.on('change', () => {
            this.load()
        })
        this.uriLoader.on('error', (error) => this.emit('error', error))

        this.load()
    }

    protected stop() {
        if (!this.running) {
            return
        }
        this.emit('stopped')
        this.running = false
    }

    protected async load() {
        this.emit('load')

        let configLoad: Object = await this.globalLoader.load()

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