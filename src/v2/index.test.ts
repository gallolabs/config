import { clone } from "lodash-es"
import { loadConfig } from "./index.js"
import { setTimeout } from "timers/promises"

const configOpts = {
    envPrefix: 'MYAPP',
    schema: {
        type: 'object',
        properties: {
            run: {type: 'boolean'},
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
            api3Url: {type: 'string'},
            api4Url: {type: 'string'},
            apiId: {type: 'integer'},
            password: {type: 'string'},
            logo: {type: 'string'}
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

    it.only('multi config', async () => {

        process.on('unhandledRejection', console.error)

        process.env.MYAPP_LOG_LEVEL='debug'

        process.env.MYAPP_CONFIG_URI='src/v2/config.test.yml'

        process.env.MYAPP_USERS_0_NAME="@ref https://dummyjson.com/todos/2#todo"

        process.env.BASE_URL="http://api.slowmocking.com"

        process.env.MYAPP_API1URL="@ref #BASE_URL&'/v1'"
        //process.env.MYAPP_API2URL="@ref env:BASE_URL#$ & '/v2'"

        process.argv.push('--users-2-name=fromArgv')

        process.argv.push('--no-run')

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