import { flatDictToDeepObject } from "../src/unflat-mapper.js"

describe.only('unflat', () => {
    it('flatDictToDeepObject', () => {

        const data = flatDictToDeepObject({
            prefix: 'APP',
            data: {
                APP_LOG_LEVEL: 'debug',
                APP_ADDITIONNAL_LOGS_MIN_LEVEL: 'info',
                APP_USERS_0_NAME: 'John',
                APP_USERS_0_CREATED_AT: '2016',
                APP_USERS_1_NAME: 'John2',
                APP_USERS_1_CREATEDAT: '2017',
                APP_REPOSITORIES_AAA_BACKUP_TAGS_0: 'tag0',
                APP_REPOSITORIES_AAA_BACKUP_TAGS_1: 'tag1',
                APP_REPOSITORIES_AAB_BACKUP_TAGS_0: 'tag0'
            },
            delimiter: '_',
            schema: {
                type: 'object',
                properties: {
                    log: {
                        type: 'object',
                        properties: {
                            level: {type: 'string'}
                        }
                    },
                    additionnalLogs: {
                        type: 'object',
                        properties: {
                            minLevel: {type: 'string'}
                        }
                    },
                    repositories: {
                        type: 'object',
                        additionalProperties: {
                            type: 'object',
                            properties: {
                                backupTags: {
                                    type: 'array',
                                    items: {
                                        type: 'string'
                                    }
                                }
                            }
                        }
                    },
                    users: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: {type: 'string'},
                                createdAt: {type: 'string'}
                            }
                        }
                    }
                }
            }
        })

        console.log(JSON.stringify(data, undefined, 4))


    })

    it('flatDictToDeepObject', () => {

        // https://json-schema.org/learn/miscellaneous-examples#arrays-of-things

        const data = flatDictToDeepObject({
            prefix: 'APP',
            data: {
                APP_FRUITS_0: 'apple',
                APP_FRUITS_1: 'orange',
                APP_VEGETABLES_0_VEGGIE_NAME: 'potato',
                APP_VEGETABLES_0_VEGGIE_LIKE: 'true',
            },
            delimiter: '_',
            schema: {
              "$id": "https://example.com/arrays.schema.json",
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "description": "A representation of a person, company, organization, or place",
              "type": "object",
              "properties": {
                "fruits": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "vegetables": {
                  "type": "array",
                  "items": { "$ref": "#/$defs/veggie" }
                }
              },
              "$defs": {
                "veggie": {
                  "type": "object",
                  "required": [ "veggieName", "veggieLike" ],
                  "properties": {
                    "veggieName": {
                      "type": "string",
                      "description": "The name of the vegetable."
                    },
                    "veggieLike": {
                      "type": "boolean",
                      "description": "Do I like this vegetable?"
                    }
                  }
                }
              }
            }

        })

        console.log(JSON.stringify(data, undefined, 4))


    })

    it('flatDictToDeepObject', () => {

        // https://json-schema.org/learn/file-system#the-full-entry-schema

        const data = flatDictToDeepObject({
            prefix: 'APP',
            data: {
                APP_STORAGE_TYPE: 'nfs',
                APP_STORAGE_REMOTE_PATH: '//nas',
                APP_STORAGE_SERVER: 'hostname',
                APP_FSTYPE: 'ext4'
            },
            delimiter: '_',
            schema: {
              "$id": "https://example.com/entry-schema",
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "description": "JSON Schema for an fstab entry",
              "type": "object",
              "required": [ "storage" ],
              "properties": {
                "storage": {
                  "type": "object",
                  "oneOf": [
                    { "$ref": "#/$defs/diskDevice" },
                    { "$ref": "#/$defs/diskUUID" },
                    { "$ref": "#/$defs/nfs" },
                    { "$ref": "#/$defs/tmpfs" }
                  ]
                },
                "fstype": {
                  "enum": [ "ext3", "ext4", "btrfs" ]
                },
                "options": {
                  "type": "array",
                  "minItems": 1,
                  "items": {
                    "type": "string"
                  },
                  "uniqueItems": true
                },
                "readonly": {
                  "type": "boolean"
                }
              },
              "$defs": {
                "diskDevice": {
                  "properties": {
                    "type": {
                      "enum": [ "disk" ]
                    },
                    "device": {
                      "type": "string",
                      "pattern": "^/dev/[^/]+(/[^/]+)*$"
                    }
                  },
                  "required": [ "type", "device" ],
                  "additionalProperties": false
                },
                "diskUUID": {
                  "properties": {
                    "type": {
                      "enum": [ "disk" ]
                    },
                    "label": {
                      "type": "string",
                      "pattern": "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$"
                    }
                  },
                  "required": [ "type", "label" ],
                  "additionalProperties": false
                },
                "nfs": {
                  "properties": {
                    "type": { "enum": [ "nfs" ] },
                    "remotePath": {
                      "type": "string",
                      "pattern": "^(/[^/]+)+$"
                    },
                    "server": {
                      "type": "string",
                      "oneOf": [
                        { "format": "hostname" },
                        { "format": "ipv4" },
                        { "format": "ipv6" }
                      ]
                    }
                  },
                  "required": [ "type", "server", "remotePath" ],
                  "additionalProperties": false
                },
                "tmpfs": {
                  "properties": {
                    "type": { "enum": [ "tmpfs" ] },
                    "sizeInMB": {
                      "type": "integer",
                      "minimum": 16,
                      "maximum": 512
                    }
                  },
                  "required": [ "type", "sizeInMB" ],
                  "additionalProperties": false
                }
              }
            }


        })

        console.log(JSON.stringify(data, undefined, 4))


    })
})