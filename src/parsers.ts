import parseEnvString from "parse-env-string"
import { RefToken, QueryToken, createTokensIfPresentFromString } from "./tokens.js"
import YAML from 'yaml'
import { parse as parseIni } from 'ini'
import toml from 'toml'
import stripJsonComments from 'strip-json-comments'
import minimist from "minimist"
import { mapValues } from "lodash-es"
import traverse from "traverse"
import stringArgv from 'string-argv'

export interface ParserOpts {
    [k: string]: any
}

export interface Parser {
    canParse(contentType: string): boolean
    parse: (content: any, opts: ParserOpts) => Promise<any>
}

export class EnvParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/x.env'
    }
    public async parse(content: string, opts: ParserOpts & { unflat?: boolean }): Promise<Object> {
        const env = parseEnvString(content.replace(/^\s*#.*/gm, '').replace(/\n/g, ' '))

        return mapValues(env, (v) => createTokensIfPresentFromString(v, '@'))
    }
}

export class ArgvParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/x.argv'
    }
    public async parse(content: string): Promise<Object> {
        const args = minimist(stringArgv(content))
        // @ts-ignore
        delete args._

        return mapValues(args, (v) => {
            if (typeof v === 'string') {
                return createTokensIfPresentFromString(v, '@')
            }
            return v
        })
    }
}

export class JsonParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/json'
    }
    public async parse(content: string): Promise<Object> {
        const obj = JSON.parse(stripJsonComments(content))

        traverse(obj).forEach(function (val) {
            if (val instanceof Object) {
                if (val.$query) {
                    return new QueryToken(val.$query)
                }
                if (val.$ref) {
                    return new RefToken(val.$ref, val.$opts || {})
                }
            }

            return val
        })

        return obj
    }
}

export class YamlParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/yaml'
    }
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

export class IniParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/x.ini'
    }
    public async parse(content: string): Promise<Object> {
        return parseIni(content)
    }
}

export class TomlParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/toml'
    }
    public async parse(content: string): Promise<Object> {
        return toml.parse(content)
    }
}

export class XmlParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/xml'
    }
    public async parse(): Promise<Object> {
        throw new Error('todo')
    }
}
