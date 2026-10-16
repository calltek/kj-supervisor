import { describe, expect, test } from 'bun:test'
import { REQUIRED_EXPORTS, checkPin, sha256, validateProtocolBody } from './protocol-validator'

const valid = `${REQUIRED_EXPORTS.map((n) =>
    n === 'AgentSpawnPayload' ? `export interface ${n} { a: string }` : `export const ${n} = 1`
).join('\n')}\n`

describe('validateProtocolBody', () => {
    test('accepts a valid body', () => {
        expect(validateProtocolBody(valid, 'text/typescript; charset=utf-8')).toEqual([])
    })
    test('rejects an HTML page served as 200', () => {
        const problems = validateProtocolBody('<!DOCTYPE html><html></html>', 'text/html')
        expect(problems.join()).toContain('HTML')
        expect(problems.join()).toContain('content-type')
    })
    test('rejects an HTML captive portal with a generic content-type', () => {
        const body = '\n <html><body>login</body></html>'
        expect(validateProtocolBody(body, 'text/plain')).not.toEqual([])
    })
    test('rejects an empty body', () => {
        expect(validateProtocolBody('  \n', 'text/typescript')).toContain('empty body')
    })
    test('rejects TypeScript that does not parse', () => {
        const problems = validateProtocolBody(`${valid}\nexport const x = {{{`, null)
        expect(problems.join()).toContain('does not parse')
    })
    test('rejects a body missing required exports', () => {
        const problems = validateProtocolBody('export const PROTOCOL_VERSION = 1\n', null)
        expect(problems.join()).toContain('KJ_LABEL')
    })
})

describe('checkPin', () => {
    test('passes when the hash matches', () => {
        expect(checkPin(valid, `${sha256(valid)}\n`)).toBeUndefined()
    })
    test('fails when the hash differs', () => {
        expect(checkPin(`${valid}// x`, sha256(valid))).toContain('mismatch')
    })
})
