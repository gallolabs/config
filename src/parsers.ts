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
import { SchemaObject } from "ajv"
import { flatDictToDeepObject } from "./unflat-mapper.js"

export interface ParserOpts {
    [k: string]: any
    schema?: SchemaObject
}

export interface Parser {
    canParse(contentType: string): boolean
    parse: (content: unknown, opts: ParserOpts, contentType: string) => Promise<any>
}

export class BinaryParser implements Parser {
    public canParse(contentType: string): boolean {
        return !contentType.startsWith('text/')
            && !contentType.startsWith('application/')
    }
    public async parse(content: unknown, _: ParserOpts, contentType: string): Promise<Object> {
        if (!(content instanceof Buffer)) {
            throw new Error('Unsupport content variable type : ' + typeof content)
        }

        return 'data:'+contentType+';base64,' + content.toString('base64')
    }
}

export class TextParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'text/plain'
    }
    public async parse(content: unknown): Promise<Object> {
        if (!(content instanceof Buffer || typeof content === 'string')) {
            throw new Error('Unsupport content variable type : ' + typeof content)
        }

        return content.toString()
    }
}

export class EnvParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/x.env'
    }
    public async parse(content: unknown, opts: ParserOpts & { unflat?: boolean, prefix?: string }): Promise<Object> {
        let contentAsObject: object

        if (content instanceof Buffer || typeof content === 'string') {
            contentAsObject = parseEnvString(content.toString().replace(/^\s*#.*/gm, '').replace(/\n/g, ' '))
        } else if (content instanceof Object) {
            contentAsObject = content
        } else {
            throw new Error('Unsupport content variable type : ' + typeof content)
        }
        const tokenizedContentAsObject = mapValues(contentAsObject, (v) => createTokensIfPresentFromString(v, '@'))

        return opts.unflat
            ? flatDictToDeepObject({ data: tokenizedContentAsObject, schema: opts.schema || {}, delimiter: '_', prefix: opts.prefix })
            : tokenizedContentAsObject

    }
}

export class ArgvParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/x.argv'
    }
    public async parse(content: unknown, opts: ParserOpts & { unflat?: boolean }): Promise<Object> {
        let contentAsObject: Record<string, any>

        if (content instanceof Buffer || typeof content === 'string') {
            contentAsObject = minimist(stringArgv(content.toString()))
        } else if (content instanceof Object) {
            contentAsObject = content
        } else {
            throw new Error('Unsupport content variable type : ' + typeof content)
        }

        delete contentAsObject._

        const tokenizedContentAsObject = mapValues(contentAsObject, (v) => {
            if (typeof v === 'string') {
                return createTokensIfPresentFromString(v, '@')
            }
            return v
        })

        return opts.unflat
            ? flatDictToDeepObject({ data: tokenizedContentAsObject, schema: opts.schema || {}, delimiter: '-' })
            : tokenizedContentAsObject
    }
}

export class JsonParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/json'
    }
    public async parse(content: unknown): Promise<Object> {
        if (!(content instanceof Buffer || typeof content === 'string')) {
            throw new Error('Unsupport content variable type : ' + typeof content)
        }

        const obj = JSON.parse(stripJsonComments(content.toString()))

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

export class YamlParser implements Parser {
    public canParse(contentType: string): boolean {
        return ['application/yaml', 'text/yaml'].includes(contentType.split(';')[0])
    }
    public async parse(content: unknown): Promise<Object> {
        if (!(content instanceof Buffer || typeof content === 'string')) {
            throw new Error('Unsupport content variable type : ' + typeof content)
        }

        const doc = YAML.parseDocument(
            content.toString(),
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
    public async parse(content: unknown): Promise<Object> {
        if (!(content instanceof Buffer || typeof content === 'string')) {
            throw new Error('Unsupport content variable type : ' + typeof content)
        }

        return parseIni(content.toString())
    }
}

export class TomlParser implements Parser {
    public canParse(contentType: string): boolean {
        return contentType.split(';')[0] === 'application/toml'
    }
    public async parse(content: unknown): Promise<Object> {
        if (!(content instanceof Buffer || typeof content === 'string')) {
            throw new Error('Unsupport content variable type : ' + typeof content)
        }
        return toml.parse(content.toString())
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
