import { describe, expect, test } from 'bun:test'

import { bodyReferences, fillBody, isSecretFieldName } from './body'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const REF = '{{kj:Shop Ruben.passwd}}'
const must = <T>(v: T | null | undefined): T => {
    if (v == null) throw new Error('expected a value')
    return v
}

describe('isSecretFieldName', () => {
    test.each([
        'password',
        'passwd',
        'client_secret',
        'refresh_token',
        'apiKey',
        'x-api-key',
        'newPassword2',
        'PIN',
    ])('%s is a secret field', (name) => expect(isSecretFieldName(name)).toBe(true))

    test.each([
        'note',
        'comment',
        'description',
        'shipping',
        'author',
        'keyword',
        'email',
    ])('%s is not', (name) => expect(isSecretFieldName(name)).toBe(false))
})

describe('bodyReferences / fillBody', () => {
    test('a body with no reference is left alone', () => {
        expect(bodyReferences('application/json', enc('{"a":1}'))).toBeNull()
        expect(bodyReferences(null, null)).toBeNull()
    })

    test('a top-level JSON field gets the value, escaped', () => {
        const found = bodyReferences(
            'application/vnd.api+json',
            enc(`{"user":{"id":1},"password":"${REF}","refresh_token":"${REF}"}`)
        )
        expect(found?.refs).toHaveLength(2)
        const out = fillBody(must(found), new Map([[REF, 'pa"ss\\ñ']]))
        expect(JSON.parse(dec(out))).toEqual({
            user: { id: 1 },
            password: 'pa"ss\\ñ',
            refresh_token: 'pa"ss\\ñ',
        })
    })

    test.each([
        ['an object', `{"metadata":{"token":"${REF}"}}`],
        ['a list', `{"tokens":["${REF}"]}`],
        ['a top-level string', `"${REF}"`],
    ])('a reference inside %s is refused', (_, body) => {
        expect(() => bodyReferences('application/json', enc(body))).toThrow()
    })

    test.each([
        'metadata[token]',
        'user.password',
        'secrets[]',
    ])('a nested form name (%s) is refused', (name) => {
        const body = `${name}=${encodeURIComponent(REF)}`
        expect(() => bodyReferences('application/x-www-form-urlencoded', enc(body))).toThrow()
    })

    test.each([
        [
            'an earlier duplicate nested under the same key',
            `{"password":"${REF}","metadata":{"t":"${REF}"},"metadata":1}`,
        ],
        ['an earlier duplicate in a field that is not a secret', `{"note":"${REF}","note":"x"}`],
        [
            'an escaped earlier duplicate',
            '{"note":"\\u007b\\u007bkj:Shop Ruben.passwd}}","note":"x"}',
        ],
    ])('a reference in %s is refused (what is checked is what is filled)', (_, body) => {
        expect(() => bodyReferences('application/json', enc(body))).toThrow()
    })

    test('only the checked positions are filled, even with the value at hand', () => {
        const body = `{"password":"${REF}","password":"${REF}","n":"{{kj"}`
        const found = must(bodyReferences('application/json', enc(body)))
        expect(found.slots).toHaveLength(2)
        expect(dec(fillBody(found, new Map([[REF, 's']])))).toBe(
            '{"password":"s","password":"s","n":"{{kj"}'
        )
    })

    test('a form with ; as separator is not split there', () => {
        const body = `a=x;passwd=${encodeURIComponent(REF)}`
        expect(() => bodyReferences('application/x-www-form-urlencoded', enc(body))).toThrow()
    })

    test('an escaped reference in JSON is found and replaced', () => {
        const body = '{"password":"\\u007b\\u007bkj:Shop Ruben.passwd}}"}'
        const found = bodyReferences('application/json', enc(body))
        expect(found?.refs[0]?.raw).toBe(REF)
        expect(dec(fillBody(must(found), new Map([[REF, 's3cret']])))).toBe('{"password":"s3cret"}')
    })

    test('an escaped reference in a field that is not a secret is refused too', () => {
        const body = '{"note":"\\u007b\\u007bkj:Shop Ruben.passwd}}"}'
        expect(() => bodyReferences('application/json', enc(body))).toThrow()
        expect(bodyReferences('application/json', enc('{"a":"\\u00f1"'))).toBeNull()
    })

    test('a percent-encoded form reference is found and replaced', () => {
        const body = `email=x&passwd=${encodeURIComponent(REF)}`
        const found = bodyReferences('application/x-www-form-urlencoded', enc(body))
        expect(found?.refs).toHaveLength(1)
        expect(dec(fillBody(must(found), new Map([[REF, 'a&b=c d']])))).toBe(
            'email=x&passwd=a%26b%3Dc%20d'
        )
    })

    test('a reference without its value never goes out as text', () => {
        const found = bodyReferences('application/json', enc(`{"password":"${REF}"}`))
        expect(() => fillBody(must(found), new Map())).toThrow()
    })

    test('a reference in a non-UTF-8 or malformed body is refused', () => {
        expect(() => bodyReferences('application/json', enc(`{"password":"${REF}"`))).toThrow()
        const bytes = new Uint8Array([...enc(`password=${REF}&x=`), 0xff])
        expect(() => bodyReferences('application/x-www-form-urlencoded', bytes)).toThrow()
    })
})
