import { cloneDeep, each } from 'lodash-es'
import fjp, {Operation} from 'fast-json-patch'
import { EventEmitter, once } from 'events'
import {SchemaObject, default as Ajv} from 'ajv'
import { RefResolver } from './ref-resolver.js'
const  { compare } = fjp
//import {flatten} from 'uni-flatten'
import traverse from 'traverse'
import jsonPointer from 'json-pointer'
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
    protected refResolving: {
        current?: {
            refResolver: RefResolver,
            abortController: AbortController
        },
        pending?: {
            refResolver: RefResolver,
            abortController: AbortController
        }
    } = {}
    protected needReload = false
    protected loading = false
    protected envPrefix?: string
    protected supportWatchChanges: boolean
    protected abortSignal?: AbortSignal

    public constructor(opts: ConfigLoaderOpts) {
        super()
        this.schema = opts.schema
        this.envPrefix = opts.envPrefix
        this.supportWatchChanges = opts.supportWatchChanges ?? false
    }

    protected createRefResolver(abortSignal: AbortSignal) {
        const refResolver = new RefResolver({
            supportWatchChanges: this.supportWatchChanges,
            abortSignal
        })
        refResolver.on('debug-trace', (info) => this.emit('debug-trace', info))
        refResolver.on('stale', () => {
            this.emit('debug-trace', {type: 'stale'})
            this.load()
        })
        refResolver.on('error', (error) => this.emit('error', error))

        return refResolver
    }

    public start(abortSignal?: AbortSignal) {
        if (this.running) {
            throw new Error('Already running')
        }
        if (abortSignal?.aborted) {
            return
        }
        abortSignal?.addEventListener('abort', () => this.stop())
        this.abortSignal = abortSignal
        this.running = true

        this.load()
    }

    protected stop() {
        if (!this.running) {
            return
        }

        this.needReload = false

        this.refResolving.current?.abortController.abort()
        this.refResolving.pending?.abortController.abort()

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
        if (this.abortSignal?.aborted) {
            return
        }

        this.emit('load')
        let candidate: Object

        this.refResolving.pending = this.refResolving.current
        const abortController = new AbortController

        this.refResolving.current = {
            abortController,
            refResolver: this.createRefResolver(abortController.signal)
        }

        try {
            candidate = await this.__load(this.refResolving.current.refResolver)
            this.emit('debug-trace', {type: 'references', references: this.refResolving.current.refResolver.getReferences()})
        } catch (e) {
            this.emit('debug-trace', {type: 'references', references: this.refResolving.current.refResolver.getReferences()})
            this.emit('error', e)
            abortController.abort(e)
            this.refResolving.current = this.refResolving.pending
            delete this.refResolving.pending
            return
        }

        this.emit('debug-trace', {type: 'candidate', candidate})

        let config: Config

        try {
            config = this.validate(candidate)
        } catch (e) {
            this.emit('error', e)
            abortController.abort(e)
            this.refResolving.current = this.refResolving.pending
            delete this.refResolving.pending
            return
        }

        const previousConfig = this.config
        this.config = config
        this.emit('loaded', config)

        this.refResolving.pending?.abortController.abort()
        delete this.refResolving.pending

        if (previousConfig) {
            this.emitChanges(previousConfig, config)
        }
    }

    protected mergeWithPaths(obj1: object, obj2: object): object {
        obj1 = cloneDeep(obj1)
        obj2 = cloneDeep(obj2)

        each(jsonPointer.dict(obj2 as any)/* flatten(obj2 as any)*/, (v, path) => {
            if (v === undefined) {
                return
            }
            jsonPointer.set(obj1, path, v)
        })

        return obj1
    }

    protected async __load(refResolver: RefResolver): Promise<object> {
        const env = await refResolver.resolve('env:', { unflat: true, schema: this.schema, prefix: this.envPrefix })
        const arg = await refResolver.resolve('arg:', { unflat: true, schema: this.schema })

        let conf = this.mergeWithPaths(env, arg)

        if ((conf as any).config) {
            conf = (conf as any).config
            if (conf instanceof Object) {
                conf = this.mergeWithPaths(conf, env)
                conf = this.mergeWithPaths(conf, arg)
            }
        }

        // Small hack
        traverse(conf).forEach(function (val) {
            if (Array.isArray(val)) {
                val = val.filter(v => v !== undefined)
                this.update(val)
            }
        })

        return conf
    }

    protected emitChanges(previousConfig: Config, config: Config) {
        const patch = compare(previousConfig, config, false)

        if (patch.length === 0) {
            return
        }

        const changeArg = {
            patch,
            config,
            previousConfig
        }

        this.emit('change', changeArg)
        const emittedPaths: string[] = []

        patch.forEach(op => {
            let pathHasListener = false

            if (!emittedPaths.includes('/')) {
                emittedPaths.push('/')
                if (this.emit('change:/', {
                    config,
                    previousConfig,
                    value: config,
                    previousValue: previousConfig,
                })) {
                    pathHasListener = true
                }
            }

            jsonPointer.parse(op.path).reduce((rootToLeafNodes: string[], node) => {
                rootToLeafNodes = rootToLeafNodes.concat(node)

                const pathToEmit = jsonPointer.compile(rootToLeafNodes)

                if (!emittedPaths.includes(pathToEmit)) {
                    emittedPaths.push(pathToEmit)

                    if (this.emit('change:' + pathToEmit, {
                        config,
                        previousConfig,
                        value: jsonPointer.get(config, rootToLeafNodes),
                        previousValue: jsonPointer.get(previousConfig, rootToLeafNodes),
                    })) {
                        pathHasListener = true
                    }
                }


                return rootToLeafNodes
            }, [])

            if (!pathHasListener) {
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
            allowDate: true,
            allErrors: true
        })

        //addFormats.default(ajv)
        // ajvKeywords.default(ajv)

        if (!ajv.validate(schema, candidateConfig)) {
            const invalidations: string[] = ajv.errors.map((error: any) => {
                return (error.instancePath ? error.instancePath/*.substring(1).replace('/', '.')*/ + ' ' : '')
                + error.message
            })

            const message = 'Configuration ' + invalidations.join(', ')

            throw new ConfigError(message, {
                config: candidateConfig,
                cause: ajv.errors
            })
        }

        return candidateConfig as Config
    }
}
