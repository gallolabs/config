import { clone } from "lodash-es"
import { loadConfig } from "./index.js"
import { setTimeout } from "timers/promises"

const configOpts = {
    envPrefix: 'MYAPP',
    schema: {
        type: 'object',
        properties: {
            log: {
                type: 'object',
                properties: {
                    level: {type: 'string'},
                    file: {type: 'string'}
                }
            },
            users: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: {type: 'integer'},
                        name: {type: 'string'}
                    }
                }
            },
            mappings: {
                type: 'object',
                additionalProperties: {
                    type: 'object',
                    properties: {
                        resolver: {type: 'string'}
                    }
                }
            },
            userId: {type: 'integer'},
            api1Url: {type: 'string'},
            api2Url: {type: 'string'},
            api3Url: {type: 'string'}
        }
    }
}

describe.only('config', () => {
    before(() => {
        const envs = clone(process.env)
        const argvCount = process.argv.length

        beforeEach(() => {
            Object.keys(process.env).forEach(k => { delete process.env[k] })
            Object.assign(process.env, envs)
            process.argv.splice(argvCount - 1)
        })
    })

    it('Simple base config', async () => {

        process.env.MYAPP_LOG_LEVEL='debug'
        process.argv.push('--log-file=here.log')

        process.env.MYAPP_USERS_0_ID='1'
        process.env.MYAPP_USERS_0_NAME='Luka'
        process.env.MYAPP_MAPPINGS_JSON_RESOLVER='JsonResolver'

        process.argv.push('--users-0-name=Miki')

        const myConfig = await loadConfig(configOpts)

        console.log('myConfig', myConfig)
    })

    it('env ext base config', async () => {

        process.env.MYAPP_LOG_LEVEL='debug'

        process.env.MYAPP_USERID="@include https://dummyjson.com/todos/2#userId"
        process.env.MYAPP_USERS_0_NAME="@include https://dummyjson.com/todos/2#todo"

        const myConfig = await loadConfig(configOpts)

        console.log('myConfig', myConfig)
    })

    it('url base config', async () => {

        process.env.MYAPP_LOG_LEVEL='debug'

        process.env.MYAPP_CONFIG_URI='https://dummyjson.com/todos#todos[0]'

        const myConfig = await loadConfig(configOpts)

        console.log('myConfig', myConfig)
    })

    it('file base config', async () => {

        process.env.MYAPP_LOG_LEVEL='debug'

        process.env.MYAPP_CONFIG_URI='src/v2/config.test.json'

        const myConfig = await loadConfig(configOpts)

        console.log('myConfig', myConfig)
    })

    it.only('multi config', async () => {

        process.on('unhandledRejection', console.error)

        process.env.MYAPP_LOG_LEVEL='debug'

        process.env.MYAPP_CONFIG_URI='src/v2/config.test.yml'

        process.env.MYAPP_USERS_0_NAME="@include https://dummyjson.com/todos/2#todo"

        process.env.BASE_URL="http://api.slowmocking.com"

        process.env.MYAPP_API1URL="$BASE_URL/v1"
        //process.env.MYAPP_API2URL="@include env:BASE_URL#$ & '/v2'"

        const ac = new AbortController

        const myConfig = loadConfig({...configOpts, watchChanges: true, abortSignal: ac.signal})

        myConfig.on('error', (error) => {
            console.error(error)
        })

        console.log('myConfig', await myConfig)

        myConfig.on('change', (change) => {
            console.log(change)
        })

        await setTimeout(10000)

        ac.abort()
    }).timeout(60000)
})