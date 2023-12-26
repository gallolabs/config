
export class RefToken {
    uri: string
    opts: object

    public constructor(uri: string, opts?: object) {
        this.uri = uri
        this.opts = opts || {}
    }

    public getUri() {
        return this.uri
    }

    public getOpts() {
        return this.opts
    }
}

export function createIncludeTokenFromString(string: string) {
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

    const opts = optsParts.length ? JSON.parse(optsParts.join(' ')) : {} // jsonata(optsParts.join(' ')).evaluate(null)
    return new RefToken(uri, opts)

}

export function createIncludeTokenFromObject(obj: Record<string, any>) {
    if (!obj.uri) {
        throw new Error('Missing uri')
    }
    return new RefToken(obj.uri, obj.opts)
}

export class QueryToken {
    query: string

    public constructor(query: string) {
        this.query = query
    }

    public getQuery() {
        return this.query
    }
}
