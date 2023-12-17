# Config

Advanced config:
- [X] from files (super-yaml, json) and envs (scoped or not)
- [X] Validated user config (with validate component with cast and defaults values)
- [X] Finalization fn to transform user config to config
- [X] watch changes and emit on change new config
- [X] watch alerts in case of no listen on watch events
- [X] watch changes included files
- [ ] watch new files and unwatch old files if new config does not use same files
- [ ] include files into config from envs (ex: APP_DB_PASSWORD='!include /run/secrets/db_password')
- [ ] Super Json (like Yaml, for example { db: { password: { $include: '/run/secrets/db_password' }, username: { $env: 'USER' } } })
- [ ] Command line arguments as config param
- [ ] Refacto, refacto, refacto

Example:

```typescript
import {loadConfig} from '@gallolabs/config'

const watchEventEmitter = new EventEmitter

watchEventEmitter.on('change:machin.truc', ({value/*, previousValue, config, previousConfig*/}) => {
    // Update service
    machinService.setTruc(value)
})

deepEqual(
    await loadConfig<Config, Config>({
        defaultFilename: __dirname + '/config.test.yml',
        envFilename: 'config',
        envPrefix: 'app',
        userProvidedConfigSchema: tsToJsSchema<Config>(),
        watchChanges: {
            onChange({config/*, previousConfig, patch*/}) {
                console.log('My new config', config)
            }
            eventEmitter: watchEventEmitter
        }
    }),
    {
        machin: {
            truc: {
                bidule: true
            }
        },
        envShell: 'hello world'
    }
)

const machinService = new MachinService(config.machin)
```
