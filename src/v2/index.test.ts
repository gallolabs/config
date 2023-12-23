import { clone } from "lodash-es"
import { loadConfig } from "./index.js"
import { once } from "events"

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
            userId: {type: 'integer'}
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
        process.env.MYAPP_LOG_LEVEL='debug'

        process.env.MYAPP_CONFIG_URI='src/v2/config.test.json'

        process.env.MYAPP_USERS_0_NAME="@include https://dummyjson.com/todos/2#todo"

        const myConfig = loadConfig({...configOpts, watchChanges: true})

        console.log('myConfig', await myConfig)

        myConfig.on('change', (change) => {
            console.log(change)
        })

        await once(myConfig, 'stopped')
    }).timeout(60000)
})