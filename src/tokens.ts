import jsonata from "jsonata"
import { RefResolver, RefResolvingOpts, Reference } from "./ref-resolver.js"
import JSON5 from 'json5'

export abstract class Token {
    abstract resolve(refResolver: RefResolver, reference: Reference): Promise<any>
}

export class RefToken extends Token {
    uri: string
    opts: object

    public constructor(uri: string, opts?: object) {
        super()
        if (uri === undefined) {
            throw new Error('Missing uri')
        }
        this.uri = uri
        this.opts = opts || {}
    }

    public async resolve(refResolver: RefResolver, reference: Reference) {
        return refResolver.resolve(this.uri, this.opts, reference)
    }
}

export class QueryToken extends Token {
    query: string

    public constructor(query: string) {
        super()
        this.query = query
    }

    public async resolve(refResolver: RefResolver, reference: Reference) {
        return jsonata(this.query).evaluate({}, {
            ref: (uri: string, opts?: RefResolvingOpts) => {
                return refResolver.resolve(uri, opts || {}, reference)
            }
        })
    }
}

export function createTokensIfPresentFromString(string: string, symbol: string): string | Token {
    const refKey = symbol + 'ref'
    const queryKey = symbol + 'query'

    if (string.startsWith(refKey + ' ')) {
        return createRefTokenFromString(string.substring((refKey + ' ').length))
    }

    if (string.startsWith(queryKey + ' ')) {
        return new QueryToken(string.substring((queryKey + ' ').length))
    }

    return string
}


export function createRefTokenFromString(string: string) {
    // let uriWithoutFragmentPart: string = ''
    // let fragmentPart: string = ''
    // let optsPart: string = ''

    // let step: 'uwfp' | 'fp' | 'op'  = 'uwfp'

    // for (let letter in string) {
    //     switch(step) {
    //         case 'uwfp':
    //             if (letter === '#') {
    //                 step = 'fp'
    //             } else if (letter === ' ') {
    //                 step = 'op'
    //             } else {
    //                 uriWithoutFragmentPart+= letter
    //             }
    //             break
    //         case 'fp':
    //             if (letter === ' ' && fragmentPart.startsWith())
    //     }

    // }

    const [uri, ...optsParts] = string.split(' ')

    const opts = optsParts.length ? JSON5.parse(optsParts.join(' ')) : {} // jsonata(optsParts.join(' ')).evaluate(null)
    return new RefToken(uri, opts)

}

export function createIncludeTokenFromObject(obj: Record<string, any>) {
    if (!obj.uri) {
        throw new Error('Missing uri')
    }
    return new RefToken(obj.uri, obj.opts)
}

