import { clone } from "lodash-es"
import { loadConfig } from "../src/index.js"
import { inspect } from "util"
import assert from "assert"
import { tsToJsSchema } from "@gallolabs/typescript-transform-to-json-schema"
import { setTimeout } from "timers/promises"
import { createWriteStream } from "fs"

interface MyAppConfig {
    run: boolean
    log?: {
        level?: string
    }
    users?: Array<{
        name: string
    }>
    api?: {
        url: string
        password?: string
    }
    logo?: string
    message?: string
    rawDummyTodo?: string
    availableRepositories?: string[]
    flatEnvs?: Record<string, string>
    admins?: Array<{firstName: string}>
    apiId?: number
}

const configOpts = {
    envPrefix: 'MYAPP',
    schema: tsToJsSchema<MyAppConfig>(),
    supportWatchChanges: true
}

async function loadTestConfig(opts: any = {}) {
    const debugStream = createWriteStream('/tmp/debug-config.json', {flags: 'w'})

    const configLoading = loadConfig<MyAppConfig>({...configOpts, ...opts})

    configLoading.on('debug-trace', (info) => {
        debugStream.write(JSON.stringify({date: new Date, ...info}, undefined, 4) + '\n')
    })

    configLoading.on('change', (change) => {
        console.log('change', inspect(change, {colors: true, depth: null}))
    })

    const config = await configLoading

    console.log(
        'config',
        inspect(config, {colors: true, depth: null})
    )

    configLoading.on('error', (error) => {
        console.log('error', inspect(error, {colors: true, depth: null}))
    })

    return config
}

describe('config', () => {

    process.on('unhandledRejection', (e, f) => console.error('unhandledRejection', e, f))

    before(() => {
        const envs = clone(process.env)
        const argvCount = process.argv.length

        beforeEach(() => {
            Object.keys(process.env).forEach(k => { delete process.env[k] })
            Object.assign(process.env, envs)
            process.argv.splice(argvCount - 1)
        })
    })

    it('basic use with envs and args', async() => {
        process.env.MYAPP_LOG_LEVEL='debug'
        process.env.MYAPP_USERS_0_NAME='fromEnv0'
        process.env.MYAPP_USERS_2_NAME='fromEnv2'
        process.argv.push('--no-run')
        process.argv.push('--users-0-name=fromArgv0')
        process.argv.push('--users-1-name=fromArgv1')

        process.env.MYAPP_NO_IN_CONFIG_ENV='that'
        process.argv.push('--no-in-config-arg=that')

        const config = await loadTestConfig()

        assert.deepEqual(
            config,
            {
                log: { level: 'debug' },
                users: [
                    { name: 'fromArgv0' },
                    { name: 'fromArgv1' },
                    { name: 'fromEnv2' }
                ],
                run: false
            }
        )
    })

    it('use of ref from env to arg', async() => {
        process.argv.push('--no-run')
        process.env.MYAPP_USERS_0_NAME='@ref arg:#user-name'

        process.argv.push('--user-name=argName')

        const config = await loadTestConfig()

        assert.deepEqual(
            config,
            {
                users: [
                    { name: 'argName' }
                ],
                run: false
            }
        )
    })

    it('use file as value from env', async() => {
        process.env.MYAPP_RUN='false'
        process.env.MYAPP_USERS='@ref file://'+process.cwd()+'/test/config.test.json#users'

        const config = await loadTestConfig()

        assert.deepEqual(
            config,
            {
                users: [
                    { name: 'Boloss' }
                ],
                run: false
            }
        )
    })

    it('load config from dir', async() => {
        process.env.MYAPP_RUN='false'

        process.env.MYAPP_CONFIG='@ref file://'+process.cwd()+'/test/dir {merge: true, deepMerge:true, watch: true}'

        process.env.MYAPP_USERS_2_NAME='envName'
        const abortController = new AbortController
        await loadTestConfig({abortSignal: abortController.signal})

        await setTimeout(10000)
        abortController.abort()
    }).timeout(10500)


    it.only('self reference fix', async() => {
        process.env.MYAPP_RUN='false'

        process.env.MYAPP_CONFIG='@ref file://'+process.cwd()+'/test/config-selfref.test.yml'

        await loadTestConfig()
    })

    it('load config from file', async() => {
        process.env.MYAPP_RUN='false'

        process.env.MYAPP_CONFIG='@ref file://'+process.cwd()+'/test/lightconfig.test.yml'

        process.env.MYAPP_USERS_0_NAME='envName'

        const config = await loadTestConfig()

        assert.deepEqual(
            config,
            {
                users: [
                    { name: 'envName' },
                    { name: 'fromYaml2' }
                ],
                api: { url: 'http://localhost', password: 'myVerySecretPassword' },
                run: false,
                logo: "data:image/vnd.microsoft.icon;base64,AAABAAEAAQECAAEAAQA4AAAAFgAAACgAAAABAAAAAgAAAAEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADL1usAAAAAAAAAAAAAAAAA"
            }
        )
    })

    it.skip('Use ref from env to env', async() => {
        process.env.MYAPP_RUN='false'
        process.env.API_BASE_URL='http://myapi.com'
        process.env.MYAPP_API_URL='@ref #API_BASE_URL'
        //process.env.MYAPP_API_URL='@ref API_BASE_URL'

        await loadTestConfig()
    })

    it('use of ref from arg to env', async() => {
        process.argv.push('--no-run')
        process.env.USER_NAME='envName'

        process.argv.push('--users-0-name=@ref env:#USER_NAME')

        const config = await loadTestConfig()

        assert.deepEqual(
            config,
            {
                users: [
                    { name: 'envName' }
                ],
                run: false
            }
        )
    })

    it.skip('multi config', async () => {

        process.env.MYAPP_LOG_LEVEL='debug'

        process.env.MYAPP_CONFIG_URI='test/config.test.yml'

        process.env.MYAPP_USERS_0_NAME="@ref https://dummyjson.com/todos/2#todo"

        process.env.BASE_URL="http://api.slowmocking.com"

        process.env.MYAPP_API1URL="@ref #BASE_URL&'/v1'"
        //process.env.MYAPP_API2URL="@ref env:BASE_URL#$ & '/v2'"

        process.argv.push('--users-2-name=fromArgv')

        process.argv.push('--no-run')

        const ac = new AbortController

        const myConfig = loadConfig({...configOpts, supportWatchChanges: true, abortSignal: ac.signal})

        myConfig.on('error', (error) => {
            console.error(error)
        })

        console.log('myConfig', await myConfig)

        myConfig.on('change', (change) => {
            console.log(change)
        })

        //await setTimeout(10000)

        ac.abort()
    }).timeout(60000)
})