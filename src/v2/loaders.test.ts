import { ProcessArgvLoader, EnvFileLoader, ProcessEnvLoader, JsonFileLoader, YamlFileLoader, HttpLoader } from "./loaders.js"

const schema = {
    type: 'object',
    properties: {
        log: {
            type: 'object',
            properties: {
                level: {type: 'string'}
            }
        },
        users: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    identity: {
                        type: 'object',
                        properties: {
                            lastName: {type: 'string'}
                        }
                    }
                }
            }
        }
    }
}

describe.only('loaders', () => {
    it('env file', async() => {
        const loader = new EnvFileLoader

        console.log(
            JSON.stringify(await loader.load(schema), undefined, 4)
        )
    })

    it ('process opts', async() => {
        const loader = new ProcessArgvLoader

        process.argv.push('--log-level=debug')
        process.argv.push('--users-0-identity-lastname=jack')

        console.log(
            JSON.stringify(await loader.load(schema), undefined, 4)
        )
    })

    it ('process envs', async() => {
        const loader = new ProcessEnvLoader

        process.env['LOG_LEVEL'] = 'error'
        process.env['USERS_0_IDENTITY_LASTNAME'] = 'Guillaume'

        console.log(
            JSON.stringify(await loader.load(schema), undefined, 4)
        )
    })

    it ('json file', async() => {
        const loader = new JsonFileLoader

        console.log(
            JSON.stringify(await loader.load(), undefined, 4)
        )
    })

    it ('yaml file', async() => {
        const loader = new YamlFileLoader

        console.log(
            JSON.stringify(await loader.load(), undefined, 4)
        )
    })

    it ('http', async() => {
        const loader = new HttpLoader

        console.log(
            JSON.stringify(await loader.load(), undefined, 4)
        )
    })
})
