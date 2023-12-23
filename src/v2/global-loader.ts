import { SchemaObject } from "ajv"
import { FileLoader, HttpLoader, ProcessArgvLoader, ProcessEnvLoader, SourceLoader } from "./loaders.js"
import { each, set, findKey, mapKeys } from 'lodash-es'
import {flatten} from 'uni-flatten'
import { stat } from "fs/promises"
import jsonata from 'jsonata'

export class GlobalLoader {
    protected loaders: Record<string, SourceLoader>
    protected schema: SchemaObject

    public constructor({envPrefix, schema}: {envPrefix?: string, schema: SchemaObject}) {
        this.schema = schema
        this.loaders = {
            env: new ProcessEnvLoader({ resolve: true, prefix: envPrefix, schema }),
            arg: new ProcessArgvLoader(schema)
        }
    }

    public async load(): Promise<Object> {
        const baseConfigs = await Promise.all([
            this.loaders.env.load(),
            this.loaders.arg.load()
        ])

        const obj: Record<string, any> = baseConfigs[0]

        each(flatten(baseConfigs[1] as any), (v, path) => {
            set(obj, path, v)
        })

        const configKey = findKey(obj, (_, k) => k.toLowerCase() === 'config')

        if (configKey) {
            const config = mapKeys(obj[configKey], (_, k) => k.toLowerCase())
            if (config.uri) {
                const pathLoadedObj = await (new UriLoader(this.schema)).load(config.uri)

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

class UriLoader {
    protected schema: SchemaObject

    public constructor(schema: SchemaObject) {
        this.schema = schema
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

    protected async loadUnfragmentedUri(uri: string): Promise<Object> {
        if (uri.startsWith('http://') || uri.startsWith('https://')) {
            return (new HttpLoader(uri)).load()
        }

        const stats = await stat(uri)

        if (stats.isDirectory()) {
            throw new Error('Not handled')
            //return (new DirLoader(uri)).load()
        }

        return (new FileLoader(this.schema, uri)).load()
    }
}