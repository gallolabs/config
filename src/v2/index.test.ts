import { loadConfig } from "./index.js"

describe.only('config', () => {
    it('Simple base config', async () => {

        process.env.MYAPP_LOG_LEVEL='debug'
        process.argv.push('--log-file=here.log')

        process.env.MYAPP_USERS_0_ID='1'
        process.env.MYAPP_USERS_0_NAME='Luka'
        process.env.MYAPP_MAPPINGS_JSON_RESOLVER='JsonResolver'

        process.argv.push('--users-0-name=Miki')

        const myConfig = await loadConfig({
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
                    }
                }
            }
        })

        console.log('myConfig', myConfig)
    })
})