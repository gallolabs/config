<p align="center">
    <img height="200" src="logo_w200.jpeg">
  <p align="center"><strong>Gallo config</strong></p>
</p>

## Work in progress in main branch

But should be good

Todo
- Detect impossible resolutions (cyclic refs, etc) and throw errors (already managed one case but not all)
- Add Yaml !env THE_ENV to use unflatten env var (but resolved ?)
- Add support of variable substition in various parsers like for envs API_URL="${BASE_URL}/api" targetting same content before unflat and resolve (subtition in parser on raw content)
- Add merge function in QueryToken with support of deepMerge with options (array, objects, etc), and with not byPathMerge, and shallowMerge ; with not ability to extend ref/merge in others contexts (in yaml ?). To test use cases.
- allowError option (only reader ?) for example to merge a local translation files with remote one and accepting remote fail without blocking everything. To see events to catch that
- Config loader load() or reload() callable method to force reloading
- emit activite.change, and various event (see debug-info), here to track the change event without adding a listener on it. Can be view like a watching activities inside the system

## Definition

Global Workflow :

- Event 'load' is emitted
- Process env & argv are read to identify config* keys (CONFIG_*, --config-* uri & opts)
- If config uri is provided, it is loaded and used as base config ; loaded uri can be watched and are cached
- Process env is unflatten thanks to the schema and merged to the base config
- Process argv then also
- The candidate config is validated (and type converted) ... or not
- If no validated, and same of any error, event 'error' is emitted
- Event 'loaded' is emitted
- If previous config was loaded, the new config is compared and :
    + Event 'change' is emitted with patches, old config and new config
    + Events 'change:xxx.xxx.xxx' are emitted with all the tree. For example if admin.identity.name is modified, are emitted :
        * change:admin
        * change:admin.identity
        * change:admin.identity.name

Notes: To use watch, both configLoader must be configured to support it, and provided config must activate it (ex CONFIG_OPTS_WATCH=true) 

Ref / Uri workflow :
- It is possible to load uri, providing transformation as fragment and options
- The $ref is called from anywhere with the format :
    + one-line (if supported) for example env : @ref ./variables#my.variable {options}
    + as dictionnary (if supported) for example yaml : !ref uri: ./variables#my.variable opts: {options}
- Transformation is handled by jsonata and so advanced query/transformations are possible. However, the readability is very bad. Prefer $query for advanced use, and keep $ref with fragment to subresource query for example
- Also is available $query for advanced uses (use multiples values, for example @query "$ref('env:BASE_URL') & $ref('arg:url-suffix')")
- Uri are resolved with a reader to read the raw value (stored in cache, and with watcher), a parser to parse depending of the content type, and parsed token (ref, query) are resolved

## Old doc

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
