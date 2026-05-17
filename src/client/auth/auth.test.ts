import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
    MissingCredentialsError,
    readAgentTokenFromDisk,
    resolveAuth,
    toHandshakeAuth,
    writeAgentTokenToDisk,
} from './auth'

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

describe('writeAgentTokenToDisk', () => {
    test('persists the token with mode 0600', () => {
        writeAgentTokenToDisk(dir, 'kjagt_abc123')

        const target = join(dir, 'token')
        expect(readAgentTokenFromDisk(dir)).toBe('kjagt_abc123')
        const mode = statSync(target).mode & 0o777
        expect(mode).toBe(0o600)
    })

    test('overwrites an existing token atomically', () => {
        writeAgentTokenToDisk(dir, 'kjagt_first')
        writeAgentTokenToDisk(dir, 'kjagt_second')
        expect(readAgentTokenFromDisk(dir)).toBe('kjagt_second')
    })

    test('creates the config dir if it does not exist', () => {
        const nested = join(dir, 'nested', 'sub')
        writeAgentTokenToDisk(nested, 'kjagt_xyz')
        expect(readAgentTokenFromDisk(nested)).toBe('kjagt_xyz')
    })

    test('refuses to write empty tokens', () => {
        expect(() => writeAgentTokenToDisk(dir, '')).toThrow()
        expect(() => writeAgentTokenToDisk(dir, '   ')).toThrow()
    })
})

describe('resolveAuth', () => {
    test('prefers KJ_AGENT_TOKEN env over disk and provisioning', () => {
        writeAgentTokenToDisk(dir, 'kjagt_from_disk')
        const auth = resolveAuth({
            config_dir: dir,
            agent_token_env: 'kjagt_from_env',
            provisioning_token: 'kjprov_xxx',
        })
        expect(auth).toEqual({ mode: 'agent', agent_token: 'kjagt_from_env' })
    })

    test('falls back to disk token when env is absent', () => {
        writeAgentTokenToDisk(dir, 'kjagt_from_disk')
        const auth = resolveAuth({
            config_dir: dir,
            agent_token_env: null,
            provisioning_token: 'kjprov_xxx',
        })
        expect(auth).toEqual({ mode: 'agent', agent_token: 'kjagt_from_disk' })
    })

    test('uses provisioning token only when no agent token is available', () => {
        const auth = resolveAuth({
            config_dir: dir,
            agent_token_env: null,
            provisioning_token: 'kjprov_xxx',
        })
        expect(auth).toEqual({ mode: 'provisioning', provisioning_token: 'kjprov_xxx' })
    })

    test('throws MissingCredentialsError when nothing is available', () => {
        expect(() =>
            resolveAuth({ config_dir: dir, agent_token_env: null, provisioning_token: null })
        ).toThrow(MissingCredentialsError)
    })
})

describe('toHandshakeAuth', () => {
    test('shapes agent_token for the handshake', () => {
        expect(toHandshakeAuth({ mode: 'agent', agent_token: 'kjagt_x' })).toEqual({
            agent_token: 'kjagt_x',
        })
    })

    test('shapes provisioning_token for the handshake', () => {
        expect(toHandshakeAuth({ mode: 'provisioning', provisioning_token: 'kjprov_y' })).toEqual({
            provisioning_token: 'kjprov_y',
        })
    })
})
