import { Reader, HttpReader } from "./readers.js"
import { cloneDeep, isEqual } from 'lodash-es'
import jsonata from 'jsonata'
import traverse from "traverse"
import { Parser } from "./parsers.js"
import { Token } from "./tokens.js"
import EventEmitter from "events"

export interface RefResolingOpts {
    // including readers & parsers options
    watch?: boolean
    [k: string]: any
}

export interface Reference {
    uriWithoutFragment: string
    opts: RefResolingOpts
    reader: Reader
    abortController: AbortController
    data: Promise<any>
}

export class RefResolver extends EventEmitter{
    protected readers: Reader[] = [
        new HttpReader
    ]

    protected parsers: Parser[] = []

    protected references: Reference[] = []

    public constructor(
        {additionalReaders}:
        {additionalReaders?: Reader[]}
    ) {
        super()
        if (additionalReaders) {
            this.readers = [...this.readers, ...additionalReaders]
        }
    }

    public clear() {
        // remove cache and stop watchers
        this.references.forEach(reference => reference.abortController.abort())
        this.references = []
    }

    public async resolve(uri: string, opts: RefResolingOpts, parentReference?: Reference): Promise<any> {
        const [uriWithoutFragment, ...fragments] = uri.split('#')
        const fragment = fragments.join('#')

        const uriWithoutFragmentHasScheme = uriWithoutFragment.includes(':')

        // parentReader is http://x/a.json and called ./b.json, calling
        // Reader a.json to resolve ./b.json as http://x/b.json
        const absoluteUriWithoutFragment =
            uriWithoutFragmentHasScheme && parentReference && parentReference.reader.resolveUri
            ? parentReference.reader.resolveUri(uriWithoutFragment, parentReference.uriWithoutFragment)
            : uriWithoutFragment

        if (!parentReference && !absoluteUriWithoutFragment) {
            throw new Error('Unable to transform no ressource')
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
                    uriWithoutFragment: absoluteUriWithoutFragment,
                    abortController,
                    opts,
                    reader,
                    data: Promise.resolve()
                }

                reference.data = (async() => {
                    const rawData = await reader.read(absoluteUriWithoutFragment, opts, abortController.signal)

                    rawData.on('stale', () => {
                        this.emit('stale')
                    })
                    rawData.on('error', () => this.emit('error'))

                    const contentType = opts.contentType || rawData.getContentType()
                    const parser = this.parsers.find(parser => parser.canParse(contentType))

                    if (!parser) {
                        throw new Error('Unable to find parser for ' + contentType + ' on ' + absoluteUriWithoutFragment)
                    }

                    return await this.resolveTokens(await parser.parse(rawData.getContent(), opts), reference)
                })()

                this.references.push(reference)
            }
        }

        if (!fragment) {
            return reference.data
        }

        return jsonata(fragment).evaluate(reference.data, {
            ref: (uri: string, opts?: RefResolingOpts) => {
                return this.resolve(uri, opts || {}, reference)
            }
        })
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
