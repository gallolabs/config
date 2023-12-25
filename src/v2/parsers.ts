import { SchemaObject } from "ajv"
import parseEnvString from "parse-env-string"
import { IncludeToken, QueryToken } from "./loaders.js"
import YAML from 'yaml'
import { flatDictToDeepObject } from "./unflat-mapper.js"

export interface ContentParser {
    parse: (content: string) => Promise<Object>
}

export class JsonParser implements ContentParser {
    public async parse(content: string): Promise<Object> {
        return JSON.parse(content)
    }
}

export class YamlParser implements ContentParser {
    public async parse(content: string): Promise<Object> {
        const customTags: YAML.Tags = [
            {
              tag: '!ref',
              resolve(uri: string) {
                return new IncludeToken(uri)
              }
            },
            {
              tag: '!query',
              resolve(query: string) {
                return new QueryToken(query)
              }
            },
            {
              tag: '!ref',
              collection: 'map',
              resolve(obj: any) {
                obj = obj.toJSON()
                return new IncludeToken(obj.uri, obj.opts)
              }
            },
        ]

        const doc = YAML.parseDocument(
            content,
            { customTags }
        )

        const warnOrErrors = doc.errors.concat(doc.warnings)

        if (warnOrErrors.length) {
            throw warnOrErrors[0]
        }

        return doc.toJS()
    }
}

export class EnvParser implements ContentParser {
    protected schema: SchemaObject

    public constructor(schema: SchemaObject) {
        this.schema = schema
    }

    public async parse(content: string): Promise<Object> {
        const env = parseEnvString(content.replace(/^\s*#.*/gm, '').replace(/\n/g, ' '))

        return flatDictToDeepObject({data: env, delimiter: '_', schema: this.schema})
    }
}