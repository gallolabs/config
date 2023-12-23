import { SchemaObject } from "ajv"
import { ProcessArgvLoader, ProcessEnvLoader, SourceLoader } from "./loaders.js"
// @ts-ignore
import { each, set } from 'lodash-es'
import {flatten} from 'uni-flatten'

export class GlobalLoader {
    protected loaders: Record<string, SourceLoader>

    public constructor({envPrefix, schema}: {envPrefix?: string, schema: SchemaObject}) {
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

        const obj = baseConfigs[0]

        each(flatten(baseConfigs[1] as any), (v, path) => {
            set(obj, path, v)
        })

        return obj
    }
}