import { readFile /*, readdir*/ } from "fs/promises"
import {chain} from 'lodash-es'
import {type SchemaObject} from 'ajv'
import minimist from 'minimist'
import got from 'got'
import { extname } from "path"
import chokidar from 'chokidar'
import EventEmitter from "events"
import { flatDictToDeepObject } from "./unflat-mapper.js"
import { QueryToken, createIncludeTokenFromString } from "./tokens.js"
import mime from "mime"

export interface ReaderOpts {
    watch?: boolean
    [k: string]: any
}

export interface Reader {
    canRead(uriWithoutFragment: string): Promise<boolean>
    read(uriWithoutFragment: string, opts: ReaderOpts, abortSignal: AbortSignal): Promise<ReadContent>
    resolveUri?(uriWithoutFragment: string, parentUriWithoutFragment: string): string
}

export class ReadContent extends EventEmitter implements ReadContent {
    protected contentType: string
    protected content: any

    public constructor(contentType: string, content: any) {
        super()
        this.contentType = contentType
        this.content = content
    }

    public getContentType() {
        return this.contentType
    }

    public getContent() {
        return this.content
    }
}

export class HttpReader implements Reader {
    async canRead(uriWithoutFragment: string): Promise<boolean> {
        return uriWithoutFragment.startsWith('http:')
            || uriWithoutFragment.startsWith('https:')
    }

    public resolveUri(uriWithoutFragment: string, parentUriWithoutFragment: string): string {
        return new URL(uriWithoutFragment, parentUriWithoutFragment).toString()
    }

    async read(uriWithoutFragment: string, opts: ReaderOpts & {watchInterval?: number}, abortSignal: AbortSignal): Promise<ReadContent> {
        const res = await got(uriWithoutFragment)

        const content = res.rawBody
        const contentType = res.headers['content-type']
            ? res.headers['content-type']
            : 'text/plain'

        const rc = new ReadContent(contentType, content)

        if (opts.watch) {
            let lastContent = content

            const nodeTimeout = setInterval(async () => {
                try {
                    const newContent = (await got(uriWithoutFragment)).rawBody

                    if (newContent !== lastContent) {
                        rc.emit('stale')
                    }

                    lastContent = newContent
                } catch (e) {
                    rc.emit('error', e)
                }
            }, opts.watchInterval || 60000)

            abortSignal.addEventListener('abort', () => {
                clearInterval(nodeTimeout)
            })
        }

        return rc
    }
}

export class FileReader implements Reader {
    async canRead(uriWithoutFragment: string): Promise<boolean> {
        return uriWithoutFragment.startsWith('file:///') // Only localhost
    }

    public resolveUri(uriWithoutFragment: string, parentUriWithoutFragment: string): string {
        return new URL(uriWithoutFragment, parentUriWithoutFragment).toString()
    }

    async read(uriWithoutFragment: string, opts: ReaderOpts, abortSignal: AbortSignal): Promise<ReadContent> {
        const content = await readFile(uriWithoutFragment)
        const contentType = mime.getType(extname(uriWithoutFragment)) || 'text/plain'

        const rc = new ReadContent(contentType, content)

        // It is too late here because file can have been modified before watch start
        if (opts.watch) {
            const watcher = chokidar
                .watch(uriWithoutFragment)
                .on('all', async(type) => {
                    if (type === 'add') {
                        return
                    }
                    rc.emit('stale')
                })
                .on('error', (error) => rc.emit('error', error))

            abortSignal.addEventListener('abort', () => {
                watcher.close().catch((error) => rc.emit('error', error))
            })
        }

        return rc
    }
}

export class ProcessArgvReader implements Reader {
    public async canRead(uriWithoutFragment: string) {
        return uriWithoutFragment.startsWith('arg:')
    }

    async read(uriWithoutFragment: string): Promise<ReadContent> {
        const args = minimist(process.argv)
        // @ts-ignore
        delete args._

        const path = uriWithoutFragment.substring(4)

        if (!path) {
            return new ReadContent('flat-object', args)
        }

        if (args[path] === undefined) {
            throw new Error('Path not found ' + path)
        }

        return new ReadContent('any', args[path])
    }
}


export class ProcessEnvReader implements Reader {
    public async canRead(uriWithoutFragment: string) {
        return uriWithoutFragment.startsWith('env:')
    }

    async read(uriWithoutFragment: string): Promise<ReadContent> {
        const env = process.env

        const path = uriWithoutFragment.substring(4)

        if (!path) {
            return new ReadContent('flat-object', env)
        }

        if (env[path] === undefined) {
            throw new Error('Path not found ' + path)
        }

        return new ReadContent('text/plain', env[path])
    }
}




// export class DirLoader implements SourceLoader {
//     protected dirpath: string

//     public constructor(dirpath: string) {
//         this.dirpath = dirpath
//     }

//     public async load(schema: SchemaObject): Promise<Object> {
//         const files = await readdir(this.dirpath)

//         const loaders = files.map(file => new FileLoader(file))

//         const objs = await Promise.all(loaders.map(loader => loader.load(schema)))

//         return objs.reduce((obj, _obj) => ({...obj, ..._obj}), {})
//     }
// }

