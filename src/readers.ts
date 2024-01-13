import { readFile, /*, readdir*/
stat} from "fs/promises"
import minimist from 'minimist'
import got from 'got'
import { extname } from "path"
import chokidar from 'chokidar'
import EventEmitter from "events"
import { Mime } from "mime"
// @ts-ignore
import standardMime from 'mime/types/standard.js'
// @ts-ignore
import othersMime from 'mime/types/other.js'
import { glob } from "glob"
import { Token } from "./tokens.js"
import { RefResolver, Reference } from "./ref-resolver.js"
import { merge } from "lodash-es"
import deepmerge from "deepmerge"

const mime = new Mime(standardMime, othersMime)

mime.define({
    'application/x.argv': ['argv'],
    'application/x.env': ['env'],
    'application/x.ini': ['ini']
}, true)

export interface ReaderOpts {
    watch?: boolean
    [k: string]: any
}

export interface Reader {
    canRead(uriWithoutFragment: string): boolean
    read(uriWithoutFragment: string, opts: ReaderOpts, abortSignal: AbortSignal): Promise<ReadContent>
    resolveUri(uriWithoutFragment: string, parentUriWithoutFragment: string): string
}

export class ReadContent extends EventEmitter {
    protected contentType: string | null
    protected content: any

    public constructor(contentType: string | null, content: any) {
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
    public canRead(uriWithoutFragment: string): boolean {
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

        if (opts.watch && !abortSignal.aborted) {
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

class DirToken extends Token {
    protected files: string[]
    protected opts: any
    public constructor(files: string[], opts: any) {
        super()
        this.files = files
        this.opts = opts

    }
    public async resolve(refResolver: RefResolver, reference: Reference) {
        const value = await Promise.all(this.files.map(file =>
            refResolver.resolve('file://' + file, {watch: this.opts.watch}, reference)
        ))

        if (this.opts.merge) {
            if (this.opts.deepMerge) {
                return deepmerge.all([{}, ...value])
                //return value.reduce((merged, toMerge) => deepmerge(merged, toMerge), {})
            }
            return merge.apply(merge, [{}, ...value])
        }

        return value
    }
}

export class FileReader implements Reader {
    public canRead(uriWithoutFragment: string): boolean {
        return uriWithoutFragment.startsWith('file://')
    }

    public resolveUri(uriWithoutFragment: string, parentUriWithoutFragment: string): string {
        return new URL(uriWithoutFragment, parentUriWithoutFragment).toString()
    }

    public async read(uriWithoutFragment: string, opts: ReaderOpts, abortSignal: AbortSignal): Promise<ReadContent> {
        // if (!uriWithoutFragment.startsWith('file:/')) {
        //     uriWithoutFragment = uriWithoutFragment.replace('file:', 'file://' + process.cwd() + '/')
        // }
        const fileUrl = new URL(uriWithoutFragment)
        const path = fileUrl.pathname

        if (fileUrl.hostname && fileUrl.hostname !== 'localhost') {
            throw new Error('Unhandled hostname')
        }

        if ((await stat(path)).isDirectory()) {
            return this.readDir(path, opts, abortSignal)
        }

        return this.readFile(path, opts, abortSignal)
    }

    protected async readDir(path: string, opts: ReaderOpts & { filePattern?: string }, abortSignal: AbortSignal) {
        const files = await glob(opts.filePattern || '**/*', {nodir: true, absolute: true, cwd: path })
        //const contents = await Promise.all(files.map(file => readFile(file)))

        // const rc = new ReadContent('application/x.multicontent', files.map((file, i) => {
        //     const contentType = mime.getType(extname(file).substring(1)) || 'text/plain'
        //     const content = contents[i]

        //     return { contentType, content }
        // }))

        // const rc = new ReadContent('application/x.', files.map(file => new RefToken('file://' + file, {watch: opts.watch})))

        const rc = new ReadContent(null, new DirToken(files.sort(), opts))

        // It is too late here because file can have been modified before watch start
        if (opts.watch && !abortSignal.aborted) {
            const watcher = chokidar
                .watch(path, {ignored: path + '/*.*'})
                .on('all', async(type, _path) => {
                    if (type === 'addDir' && _path === path) {
                        return
                    }
                    rc.emit('stale')
                })
                .on('error', (error) => rc.emit('error', error))

            watcher.on('ready', () => rc.emit('debug-trace', { type: 'watching' }))

            abortSignal.addEventListener('abort', () => {
                rc.emit('debug-trace', { type: 'unwatching' })
                watcher.close().catch((error) => rc.emit('error', error))
            })
        }

        return rc
    }

    protected async readFile(path: string, opts: ReaderOpts, abortSignal: AbortSignal) {
        const content = await readFile(path)
        const contentType = mime.getType(extname(path).substring(1)) || 'text/plain'

        const rc = new ReadContent(contentType, content)

        // It is too late here because file can have been modified before watch start
        if (opts.watch && !abortSignal.aborted) {
            const watcher = chokidar
                .watch(path)
                .on('all', async(type) => {
                    if (type === 'add') {
                        return
                    }
                    rc.emit('stale')
                })
                .on('error', (error) => rc.emit('error', error))

            watcher.on('ready', () => rc.emit('debug-trace', { type: 'watching' }))

            abortSignal.addEventListener('abort', () => {
                rc.emit('debug-trace', { type: 'unwatching' })
                watcher.close().catch((error) => rc.emit('error', error))
            })
        }

        return rc
    }
}

export class ProcessArgvReader implements Reader {
    public canRead(uriWithoutFragment: string) {
        return uriWithoutFragment.startsWith('arg:')
    }

    public resolveUri(_uriWithoutFragment: string, parentUriWithoutFragment: string): string {
        return parentUriWithoutFragment
    }

    async read(uriWithoutFragment: string): Promise<ReadContent> {
        const args = minimist(process.argv)
        // @ts-ignore
        delete args._

        const path = uriWithoutFragment.substring(4)

        if (!path) {
            return new ReadContent('application/x.argv', args)
        }

        if (args[path] === undefined) {
            throw new Error('Path not found ' + path)
        }

        return new ReadContent('any', args[path])
    }
}

export class ProcessEnvReader implements Reader {
    public canRead(uriWithoutFragment: string) {
        return uriWithoutFragment.startsWith('env:')
    }

    public resolveUri(_uriWithoutFragment: string, parentUriWithoutFragment: string): string {
        return parentUriWithoutFragment
    }

    async read(uriWithoutFragment: string): Promise<ReadContent> {
        const env = process.env

        const path = uriWithoutFragment.substring(4)

        if (!path) {
            return new ReadContent('application/x.env', env)
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

