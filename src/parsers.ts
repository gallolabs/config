import { SchemaObject } from "ajv"
import parseEnvString from "parse-env-string"
import { RefToken, QueryToken } from "./tokens.js"
import YAML from 'yaml'
import { flatDictToDeepObject } from "./unflat-mapper.js"
import { parse as parseIni } from 'ini'
import toml from 'toml'
import stripJsonComments from 'strip-json-comments'

export interface Parser {
    canParse(contentType: string): boolean
    parse: (content: any, opts: any) => Promise<any>
}


export class ArgsParser implements ContentParser {
    public async parse(_content: string): Promise<Object> {
        throw new Error('Todo')
    }
}

export class JsonParser implements ContentParser {
    public async parse(content: string): Promise<Object> {
        return JSON.parse(stripJsonComments(content))
    }
}

export class IniParser implements ContentParser {
    public async parse(content: string): Promise<Object> {
        return parseIni(content)
    }
}

export class TomlParser implements ContentParser {
    public async parse(content: string): Promise<Object> {
        return toml.parse(content)
    }
}


export class YamlParser implements ContentParser {
    public async parse(content: string): Promise<Object> {
        const customTags: YAML.Tags = [
            {
              tag: '!ref',
              resolve(uri: string) {
                return new RefToken(uri)
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
                return new RefToken(obj.uri, obj.opts)
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

        // Todo move to globalLoader
        const fullPrefix = this.prefix
            ? this.prefix.toLowerCase() + (this.prefix.endsWith('_') ? '' : '_')
            : null

        const env: Record<string, any> = fullPrefix
            ? chain(process.env)
                .pickBy((_, key) => key.toLowerCase().startsWith(fullPrefix))
                .mapKeys((_, key) => key.substring(fullPrefix.length))
                .value()
            : process.env
// Todo move to parser
        for (const key in env) {
            if(typeof env[key] === 'string' && (env[key] as string).startsWith('@ref')) {
                env[key] = createIncludeTokenFromString((env[key] as string).split(' ').slice(1).join(' '))
            }
            if(typeof env[key] === 'string' && (env[key] as string).startsWith('@query')) {
                env[key] = new QueryToken((env[key] as string).split(' ').slice(1).join(' '))
            }
        }
        // Todo move to globalLoader
        return this.resolve ? flatDictToDeepObject({data: env, delimiter: '_', schema: this.schema}) : env
    }