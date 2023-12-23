import { SchemaObject } from "ajv"
import { FileLoader, HttpLoader, ProcessArgvLoader, ProcessEnvLoader, SourceLoader } from "./loaders.js"
import { each, set, findKey, mapKeys, cloneDeep } from 'lodash-es'
import {flatten} from 'uni-flatten'
import { stat } from "fs/promises"
import jsonata from 'jsonata'
import EventEmitter from "events"

export class GlobalLoader {
    protected loaders: Record<string, SourceLoader>
    protected uriLoader: UriLoader

    public constructor({envPrefix, schema, uriLoader}: {envPrefix?: string, schema: SchemaObject, uriLoader: UriLoader}) {
        this.uriLoader = uriLoader
        this.loaders = {
            env: new ProcessEnvLoader({ resolve: true, prefix: envPrefix, schema, uriLoader: this.uriLoader }),
            arg: new ProcessArgvLoader(schema)
        }
    }

    public async load(): Promise<Object> {
        const baseConfigs = await Promise.all([
            this.loaders.env.load(),
            this.loaders.arg.load()
        ])
        const obj: Record<string, any> = cloneDeep(baseConfigs[0])

        each(flatten(baseConfigs[1] as any), (v, path) => {
            set(obj, path, v)
        })

        const configKey = findKey(obj, (_, k) => k.toLowerCase() === 'config')

        if (configKey) {
            const config = mapKeys(obj[configKey], (_, k) => k.toLowerCase())
            if (config.uri) {
                const pathLoadedObj = await this.uriLoader.load(config.uri)

                Object.assign(obj, pathLoadedObj)

                each(flatten(baseConfigs[0] as any), (v, path) => {
                    set(obj, path, v)
                })

                each(flatten(baseConfigs[1] as any), (v, path) => {
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
        loader: SourceLoader
        watchAbortController?: AbortController
        value?: Promise<Object>
    }> = {}
    protected watchChanges: boolean

    public constructor(schema: SchemaObject, watchChanges: boolean) {
        super()
        this.schema = schema
        this.watchChanges = watchChanges
    }

    public async load(uri: string): Promise<Object> {
        const [unfragmentedUri, ...fragments] = uri.split('#')

        const data = await this.loadUnfragmentedUri(unfragmentedUri)

        const fragment = fragments.join('#')

        if (!fragment) {
            return data
        }

        return jsonata(fragment).evaluate(data)
    }

    protected async proxyLoad(uri: string, loader: SourceLoader): Promise<Object> {
        if (!this.loaded[uri]) {
            this.loaded[uri] = { loader }

            if (this.watchChanges && loader.watch) {
                const ac = new AbortController
                const em = loader.watch(ac.signal)
                this.loaded[uri].watchAbortController = ac

                em.on('change', () => {
                    delete this.loaded[uri]?.value
                    this.emit('change')
                })
                em.on('error', () => this.emit('error'))
            }
        }
        if (!this.loaded[uri].value) {
            this.loaded[uri].value = loader.load()
        }
        return this.loaded[uri].value!
    }

    protected async loadUnfragmentedUri(uri: string): Promise<Object> {
        if (this.loaded[uri]?.value) {
            return this.loaded[uri].value!
        }

        if (uri.startsWith('http://') || uri.startsWith('https://')) {
            return this.proxyLoad(uri, (new HttpLoader(uri)))
        }

        const stats = await stat(uri)

        if (stats.isDirectory()) {
            throw new Error('Not handled')
            //return (new DirLoader(uri)).load()
        }

        return this.proxyLoad(uri, new FileLoader(this.schema, uri))
    }
}