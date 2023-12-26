import { SchemaObject } from "ajv"
import { Reader, ReaderFactory, builtinReaderFactories } from "./readers.js"
import { cloneDeep } from 'lodash-es'
import { stat } from "fs/promises"
import jsonata from 'jsonata'
import EventEmitter from "events"
import traverse from "traverse"
import { dirname, resolve as resolvePath } from 'path'

export interface RefResolingOpts {
    // including readers & parsers options
}

export class RefResolver {
    protected readerFactories = builtinReaderFactories

    public constructor(
        {additionalReaderFactories}:
        {additionalReaderFactories?: ReaderFactory<any>[]}
    ) {
        if (additionalReaderFactories) {
            this.readerFactories = [...additionalReaderFactories, ...this.readerFactories]
        }
    }

    public async resolve(uri: string, opts: RefResolingOpts, parentReader?: Reader): Promise<any> {
        let [unfragmentedUri, ...fragments] = uri.split('#')
        const fragment = fragments.join('#')

        // parentReader is http://x/a.json and called ./b.json, calling
        // Reader a.json to resolve ./b.json as http://x/b.json
        if (parentReader && parentReader.resolveUri) {
            unfragmentedUri = parentReader.resolveUri(unfragmentedUri)
        }

        if (!parentReader && !unfragmentedUri) {
            throw new Error('Unable to transform no ressource')
        }

        const reader = unfragmentedUri
            ? await this.getReaderFor(unfragmentedUri, opts)
            : parentReader

        const data = await reader!.read()

        if (!fragment) {
            return data
        }

        return this.applyTransformation(data, fragment, reader!)
    }

    protected async getReaderFor(unfragmentedUri: string, opts: RefResolingOpts): Promise<Reader> {
        for (const readerFactory of this.readerFactories) {
            if (await readerFactory.canRead(unfragmentedUri)) {
                return readerFactory.create(unfragmentedUri, opts)
            }
        }

        throw new Error('Unable to find reader for ' + unfragmentedUri)
    }

    protected applyTransformation(data: any, fragment: string, reader: Reader): Promise<any> {
        return jsonata(fragment).evaluate(data, {
            ref: (uri: string, opts?: RefResolingOpts) => {
                return this.resolve(uri, opts || {}, reader)
            }
        })
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