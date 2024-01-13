import { SchemaObject } from "ajv"
import { chain, each, omit } from "lodash-es"
import traverse from "traverse"
import jsonPointer from 'json-pointer'

export function flatDictToDeepObject(
    {data, delimiter, schema, prefix, schemaSubPath}:
    {data: Record<string, any>, delimiter: string, schema: SchemaObject, prefix?: string, schemaSubPath?: string}
) {
    const fullPrefix = prefix
        ? prefix.toLowerCase() + (prefix.endsWith(delimiter) ? '' : delimiter)
        : null

    if (fullPrefix) {
        data = chain(data)
            .pickBy((_, key) => key.toLowerCase().startsWith(fullPrefix))
            .mapKeys((_, key) => key.substring(fullPrefix.length))
            .value()
    }

    const obj = {}
    schema = unrefSchema(schema)

    // See https://npm.runkit.com/json-schema-library getSchema with pointer
    // if (schemaSubPath) {
    //     schema = resolveSubSchema(schema, schemaSubPath)
    // }

    if (schemaSubPath) {
        schemaSubPath = schemaSubPath.split('.').join(delimiter)
    }

    each(data, (value, key) => {
        const path = '/' + resolveFlatPath2((schemaSubPath ? schemaSubPath + delimiter + key : key).split(delimiter).map(v => v.toLowerCase()), schema)
        //const path = resolveFlatPath(schemaSubPath ? schemaSubPath + delimiter + key : key, delimiter, schema)


        jsonPointer.set(obj, path.replace(failTokenButShouldBeRefactorized, ''), value)
    })

    return obj
}

function findCombinaison(key: string, path: string[]) {
    const candidateKey = key.replace(/_/g, '')
    for (let cursor = 0; cursor < path.length; cursor++) {
        const candidate = path.slice(0, cursor + 1).join('')
        if (candidate.toLowerCase() === candidateKey.toLowerCase()) {
            return cursor + 1
        }
        if (candidate.length >= key.length) {
            break
        }
    }
}

const failTokenButShouldBeRefactorized = Math.random().toString()

// should returns either /xxx instead to add / at the end if not empty
// Or should returns array, pushing elements avoiding to waste time with escape
function resolveFlatPath2(path: string[], schema: any): string {
    if (schema.oneOf) {
        const candidates = schema.oneOf.map((a: any) => resolveFlatPath2(path, {...schema, ...a, oneOf: undefined}))

        return candidates.find((c: any) => !c.includes(failTokenButShouldBeRefactorized)) || candidates[0]
    }
    if (schema.allOf) {
        const candidates = schema.allOf.map((a: any) => resolveFlatPath2(path, {...schema, ...a, allOf: undefined}))

        return candidates.find((c: any) => !c.includes(failTokenButShouldBeRefactorized)) || candidates[0]
    }
    if (schema.anyOf) {
        const candidates = schema.anyOf.map((a: any) => resolveFlatPath2(path, {...schema, ...a, anyOf: undefined}))

        return candidates.find((c: any) => !c.includes(failTokenButShouldBeRefactorized)) || candidates[0]
    }
    if (schema.if) {
        const candidate = resolveFlatPath2(path, {...schema, ...schema.if, if: undefined})

        if (!candidate.includes(failTokenButShouldBeRefactorized)) {
            return candidate
        }
    }
    if (schema.then) {
        const candidate = resolveFlatPath2(path, {...schema, ...schema.then, then: undefined})

        if (!candidate.includes(failTokenButShouldBeRefactorized)) {
            return candidate
        }
    }
    // Seems to be tolerant
    if (schema.type === 'object' || schema.properties || schema.additionalProperties) {
        const properties = schema.properties

        for (const propKey in properties) {
            const cursor = findCombinaison(propKey, path)
            if (cursor) {
                const resolvedNext = resolveFlatPath2(path.slice(cursor), properties[propKey])
                return propKey + (resolvedNext ? '/' + resolvedNext : '')
            }
        }

        if (typeof schema.additionalProperties === 'object') {
            const key = path[0]
            const resolvedNext = resolveFlatPath2(path.slice(1), schema.additionalProperties)
            return key + (resolvedNext ? '/' + resolvedNext : '')
        }

        return path.map(p => jsonPointer.escape(p)).join('.') + failTokenButShouldBeRefactorized
    }

    if (schema.type === 'array') {
        const index = path[0]
        const resolvedNext = resolveFlatPath2(path.slice(1), schema.items)
        return index + (resolvedNext ? '/' + resolvedNext : '')
    }

    return path.map(p => jsonPointer.escape(p)).join('/')
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
        const path = $ref.substring(1)
        return {
            ...omit(o, '$ref'),
            ...resolveRef(jsonPointer.get(schema, path))
        }
    }

    const resolved = traverse(schema).map(resolveRef)
    delete resolved.definitions

    return resolved
}
