import { SchemaObject } from "ajv"
import { each, get, omit, set } from "lodash-es"
import traverse from "traverse"

export function flatDictToDeepObject({data, delimiter, schema}: {data: Record<string, any>, delimiter: string, schema: SchemaObject}) {
    const obj = {}
    schema = unrefSchema(schema)

    each(data, (value, key) => {
        const path = resolveFlatPath(key, delimiter, schema)
        set(obj, path, value)
    })

    return obj
}

function resolveFlatPath(path: string, delimiter: string, schema: any): string {

    if (schema.type === 'object') {
        const properties = schema.properties

        for (const propKey in properties) {
            if (propKey.toLowerCase() === path.substring(0, propKey.length).toLowerCase()) {
                const consumedPath = path.substring(propKey.length)
                if (consumedPath.length === 0 || consumedPath.substring(0, delimiter.length) === delimiter) {
                    const resolvedNext = resolveFlatPath(consumedPath.substring(delimiter.length), delimiter, properties[propKey])
                    return propKey + (resolvedNext ? '.' + resolvedNext : '')
                }
            }
        }

        if (typeof schema.additionalProperties === 'object') {
            const key = path.split(delimiter)[0]
            const resolvedNext = resolveFlatPath(path.substring(key.length + delimiter.length), delimiter, schema.additionalProperties)
            return key + (resolvedNext ? '.' + resolvedNext : '')
        }
    }

    if (schema.type === 'array') {
        const index = path.split(delimiter)[0]
        const resolvedNext = resolveFlatPath(path.substring(index.length + delimiter.length), delimiter, schema.items)
        return index + (resolvedNext ? '.' + resolvedNext : '')
    }

    return path.split(delimiter).join('.')
}

function unrefSchema(schema: Object) {
    function resolveRef(o: any): any {
        if (!(o instanceof Object && o.$ref)) {
            return o
        }
        const $ref = o.$ref
        if ($ref.substring(0, 1) !== '#') {
            throw new Error('Unexpected external resource')
        }
        const path = $ref.substring(2).replace(/\//g, '.')
        return {
            ...omit(o, '$ref'),
            ...resolveRef(get(schema, path))
        }
    }

    const resolved = traverse(schema).map(resolveRef)
    delete resolved.definitions

    return resolved
}
