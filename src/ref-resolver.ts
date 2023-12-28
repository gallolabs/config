import { Reader, HttpReader, FileReader, ProcessArgvReader, ProcessEnvReader } from "./readers.js"
import { cloneDeep, get, isEqual } from 'lodash-es'
import traverse from "traverse"
import { ArgvParser, BinaryParser, EnvParser, IniParser, Json5Parser, JsonParser, /*MulticontentParser,*/ Parser, TextParser, TomlParser, XmlParser, YamlParser } from "./parsers.js"
import { Token } from "./tokens.js"
import EventEmitter from "events"
import { SchemaObject } from "ajv"

export interface RefResolvingOpts {
    // including readers & parsers options
    watch?: boolean
    contentType?: string
    schema?: SchemaObject
    [k: string]: any
}

export interface Reference {
    uid: string
    uriWithoutFragment: string
    opts: RefResolvingOpts
    reader: Reader
    abortController: AbortController
    data: Promise<any>
    parent?: Reference
}

export class RefResolver extends EventEmitter {
    protected readers: Reader[] = [
        new HttpReader,
        new FileReader,
        new ProcessArgvReader,
        new ProcessEnvReader
    ]

    protected parsers: Parser[] = [
        new ArgvParser,
        new EnvParser,
        new JsonParser,
        new Json5Parser,
        new IniParser,
        new TomlParser,
        new YamlParser,
        new XmlParser,
        new TextParser,
        //new MulticontentParser,
        new BinaryParser
    ]

    protected references: Reference[] = []

    protected supportWatchChanges

    protected uid = (Math.random()).toString()

    public constructor(
        {additionalReaders, additionalParsers, supportWatchChanges}:
        {additionalReaders?: Reader[], additionalParsers?: Parser[], supportWatchChanges?: boolean}
    = {}) {
        super()
        if (additionalReaders) {
            this.readers = [...this.readers, ...additionalReaders]
        }
        if (additionalParsers) {
            this.parsers = [...this.parsers, ...additionalParsers]
        }
        this.supportWatchChanges = supportWatchChanges ?? true
    }

    public clear() {
        // remove cache and stop watchers
        this.references.forEach(reference => reference.abortController.abort())
        this.references = []
    }

    public getReferences() {
        return this.references
    }

    public async resolve(uri: string, opts: RefResolvingOpts = {}, parentReference?: Reference): Promise<any> {

        this.emit('debug-info', {
            type: 'resolve',
            uid: this.uid,
            uri,
            opts,
            parentReference
        })

        const [uriWithoutFragment, ...fragments] = uri.split('#')
        const fragment = fragments.join('#')

        const uriWithoutFragmentHasScheme = uriWithoutFragment.includes(':')

        // parentReader is http://x/a.json and called ./b.json, calling
        // Reader a.json to resolve ./b.json as http://x/b.json
        const absoluteUriWithoutFragment =
            !uriWithoutFragmentHasScheme && parentReference
            ? parentReference.reader.resolveUri(uriWithoutFragment, parentReference.uriWithoutFragment)
            : uriWithoutFragment

        if (parentReference && parentReference.parent && absoluteUriWithoutFragment === parentReference.parent.uriWithoutFragment) {
            throw new Error('Circular reference on ' + absoluteUriWithoutFragment + ' and ' + parentReference.uriWithoutFragment)
        }

        if (!parentReference && !absoluteUriWithoutFragment) {
            throw new Error('Unable to transform no ressource')
        }

        if (!this.supportWatchChanges) {
            opts.watch = false
        } else {
            if (opts.watch === undefined && parentReference) {
                opts.watch = parentReference.opts.watch
            }
        }

        let reference: Reference

        if (!absoluteUriWithoutFragment) {
            reference = parentReference!
        } else {
            const existingReference = this.references.find(reference => {
                return reference.uriWithoutFragment === absoluteUriWithoutFragment
                    && isEqual(reference.opts, opts)
            })

            if (existingReference) {
                reference = existingReference
            } else {
                const reader = this.readers.find(reader => reader.canRead(absoluteUriWithoutFragment))

                if (!reader) {
                    throw new Error('Unable to find reader for ' + absoluteUriWithoutFragment)
                }

                const abortController = new AbortController

                reference = {
                    uid: (Math.random()).toString(),
                    uriWithoutFragment: absoluteUriWithoutFragment,
                    abortController,
                    opts,
                    reader,
                    data: Promise.resolve(),
                    parent: parentReference
                }

                reference.data = (async() => {
                    const rawData = await reader.read(absoluteUriWithoutFragment, opts, abortController.signal)
                    rawData.on('stale', () => {
                        this.emit('stale')
                    })
                    rawData.on('error', () => this.emit('error'))
                    rawData.on('debug-info', (info) => {
                        this.emit('debug-info', {
                            refResolverUid: this.uid,
                            ...info,
                            subject: 'ReadData',
                            reference
                        })
                    })

                    const contentType = opts.contentType || rawData.getContentType()
                    let parsedData

                    if (contentType) {
                        const parser = this.parsers.find(parser => parser.canParse(contentType))

                        if (!parser) {
                            throw new Error('Unable to find parser for ' + contentType + ' on ' + absoluteUriWithoutFragment)
                        }
                        parsedData = await parser.parse(rawData.getContent(), opts, contentType)
                    } else {
                        parsedData = rawData.getContent()
                    }

                    return await this.resolveTokens(parsedData, reference)
                })()

                this.references.push(reference)
            }
        }

        const data = await reference.data

        if (!fragment) {
            return data
        }

        const subRessource = get(data, fragment)

        if (subRessource === undefined) {
           throw new Error('subRessource not found : ' + fragment + ' on ' + absoluteUriWithoutFragment)
        }

        return subRessource
    }

    protected async resolveTokens(data: any, reference: Reference) {
        if (data instanceof Token) {
            return this.resolveToken(data, reference)
        }

        data = cloneDeep(data)

        const resolutions: Promise<any>[] = []

        const self = this

        traverse(data).forEach(function (val) {
            if (val instanceof Token) {
                resolutions.push(
                    self.resolveToken(val, reference).then(v => this.update(v))
                )
            }
            return val
        })

        await Promise.all(resolutions)

        return data
    }

    protected resolveToken(token: Token, reference: Reference) {
        return token.resolve(this, reference)
    }
}
