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
    protected globalLoader: GlobalLoader
    protected refResolver: RefResolver
    protected needReload = false
    protected loading = false

    public constructor(opts: ConfigLoaderOpts) {
        super()
        this.schema = opts.schema
        this.supportWatchChanges = opts.supportWatchChanges || false
        this.refResolver = new RefResolver({})
        this.globalLoader = new GlobalLoader({
            envPrefix: opts.envPrefix,
            schema: this.schema,
            refResolver: this.refResolver
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

export class GlobalLoader {
    protected loaders: Record<string, SourceReader>
    protected refResolver: RefResolver

    public constructor({envPrefix, schema, refResolver}: {envPrefix?: string, schema: SchemaObject, refResolver: RefResolver}) {
        this.refResolver = refResolver
        this.loaders = {
            env: new ProcessEnvLoader({ resolve: true, prefix: envPrefix, schema }),
            arg: new ProcessArgvLoader(schema, true)
        }
    }

    public async load(): Promise<Object> {
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
                const pathLoadedObj = await this.uriLoader.load(config.uri)

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
}


export class UriLoader extends EventEmitter {
    protected schema: SchemaObject
    protected loaded: Record<string, {
        loader: Reader
        watchAbortController?: AbortController
        value?: Promise<Object>
    }> = {}
    protected watchChanges: boolean

    public constructor(schema: SchemaObject, watchChanges: boolean) {
        super()
        this.schema = schema
        this.watchChanges = watchChanges
    }

    public async load(uri: string, parentUri?: string, opts?: object): Promise<Object> {
        const [unfragmentedUri, ...fragments] = uri.split('#')

        const data = await this.loadUnfragmentedUri(unfragmentedUri, parentUri, opts)

        const fragment = fragments.join('#')

        if (!fragment) {
            return data
        }

        return this.resolveFragment(data, fragment)
    }

    public clearCaches() {
        Object.keys(this.loaded).forEach(uri => {
            delete this.loaded[uri].value
        })
    }

    public stopWatches() {
        Object.keys(this.loaded).forEach(uri => {
            this.loaded[uri].watchAbortController?.abort()
        })
    }

    protected async resolveFragment(data: any, fragment: string, parentUri?: string) {
        return jsonata(fragment).evaluate(data, {
            ref: (uri: string, opts: object) => {
                return this.load(uri, parentUri, opts)
            }
        })
    }

    protected async proxyLoad(uri: string, loader: Reader): Promise<Object> {
        if (!this.loaded[uri]) {
            this.loaded[uri] = { loader }
        }

        if (this.watchChanges && loader.watch && !this.loaded[uri].watchAbortController) {
            const ac = new AbortController
            const em = loader.watch(ac.signal)
            this.loaded[uri].watchAbortController = ac

            em.on('change', () => {
                delete this.loaded[uri]?.value
                this.emit('change')
            })
            em.on('error', () => this.emit('error'))
        }

        if (!this.loaded[uri].value) {
            this.loaded[uri].value = await loader.load() as any
        }

        return this.resolveTokens(this.loaded[uri].value!, uri)
    }

    public async resolveTokens(value: any, parentUri: string): Promise<any> {
        if (value instanceof RefToken) {
            return this.load(value.getUri())
        }

        if (!(value instanceof Object)) {
            return value
        }

        value = cloneDeep(value)

        const resolutions: Promise<any>[] = []

        const self = this

        traverse(value).forEach(function (val) {
            if (val instanceof RefToken) {

                let resolution: Promise<any>

                if (val.getUri().startsWith('#')) {
                    if (parentUri === 'env:' || parentUri === 'arg:') {
                        resolution = self.load(parentUri + val.getUri(), undefined, val.getOpts())
                    } else {
                        resolution = self.resolveFragment(value, val.getUri().substring(1))
                    }
                } else {
                    resolution = self.load(val.getUri(), parentUri, val.getOpts())
                }

                resolutions.push(resolution)
                resolution.then(v => this.update(v))
            }
            if (val instanceof QueryToken) {
                let resolution: Promise<any>

                resolution = self.resolveFragment({}, val.getQuery(), parentUri)
                resolutions.push(resolution)
                resolution.then(v => this.update(v))
            }
            return val
        })

        await Promise.all(resolutions)

        return value
    }

    protected async loadUnfragmentedUri(uri: string, parentUri?: string, opts?: object): Promise<any> {
        if (this.loaded[uri]?.value) {
            return this.loaded[uri].value!
        }

        if (uri.startsWith('env:')) {
            const envs = await this.proxyLoad('env:', new ProcessEnvLoader({ resolve: false, schema: this.schema }))

            if (uri === 'env:') {
                return envs
            }

            return (envs as any)[uri.substring(4)]
        }

        if (uri.startsWith('arg:')) {
            const envs = await this.proxyLoad('arg:', new ProcessArgvLoader({ resolve: false, schema: this.schema }))

            if (uri === 'arg:') {
                return envs
            }

            return (envs as any)[uri.substring(4)]
        }

        if (uri.startsWith('http://') || uri.startsWith('https://')) {
            return this.proxyLoad(uri, (new HttpLoader(uri, this.schema, opts)))
        }

        if (parentUri && uri.startsWith('.')) {
            uri = resolvePath(dirname(parentUri), uri)
        } else {
            uri = resolvePath(process.cwd(), uri)
        }

        const stats = await stat(uri)

        if (stats.isDirectory()) {
            throw new Error('Not handled directories')
            //return (new DirLoader(uri)).load()
        }

        return this.proxyLoad(uri, new FileLoader(this.schema, uri))
    }
}