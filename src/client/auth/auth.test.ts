import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MissingAgentTokenError, loadAgentToken, readAgentTokenFromDisk } from './auth'

let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kj-agent-auth-'))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe('readAgentTokenFromDisk', () => {
    test('returns null when the file does not exist', () => {
        expect(readAgentTokenFromDisk(dir)).toBeNull()
    })

    test('returns the token trimmed', () => {
        writeFileSync(join(dir, 'token'), '  kjagt_deadbeef  \n')
        expect(readAgentTokenFromDisk(dir)).toBe('kjagt_deadbeef')
    })

    test('returns null when the file is empty', () => {
        writeFileSync(join(dir, 'token'), '   \n')
        expect(readAgentTokenFromDisk(dir)).toBeNull()
    })
})

describe('loadAgentToken', () => {
    test('returns the token when present on disk', () => {
        writeFileSync(join(dir, 'token'), 'kjagt_present')
        expect(loadAgentToken(dir)).toBe('kjagt_present')
    })

    test('throws MissingAgentTokenError when the token file is absent', () => {
        expect(() => loadAgentToken(dir)).toThrow(MissingAgentTokenError)
    })

    test('throws MissingAgentTokenError when the token file is empty', () => {
        writeFileSync(join(dir, 'token'), '   \n')
        expect(() => loadAgentToken(dir)).toThrow(MissingAgentTokenError)
    })
})
