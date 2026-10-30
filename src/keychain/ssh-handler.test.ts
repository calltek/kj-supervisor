import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'

import type { KeychainResolveAck } from './control-protocol'
import { silentLog } from './log'
import { AgentTokenRegistry } from './registry'
import type { ResolveRequest } from './resolver'
import { SSH_KEY_FIELD, SSH_KEY_PATH, SSH_SIGN_PATH, createSshHandler } from './ssh-handler'
import { parseSshPrivateKey } from './ssh-keys'

const TOKEN = 'agent-token-42'
const SESSION = '11111111-2222-4333-8444-555555555555'
const PEM = generateKeyPairSync('ed25519').privateKey.export({
    format: 'pem',
    type: 'pkcs8',
}) as string
const PUBLIC = parseSshPrivateKey(PEM).public_blob.toString('base64')

function setup(ack: KeychainResolveAck = { ok: true, value: PEM, sites: [] }) {
    const registry = new AgentTokenRegistry()
    registry.set(42, TOKEN)
    const resolves: ResolveRequest[] = []
    const handle = createSshHandler({
        registry,
        resolve: async (request) => {
            resolves.push(request)
            return ack
        },
        log: silentLog,
    })
    return { handle, resolves }
}

function post(path: string, body: unknown, token = TOKEN) {
    return new Request(`http://kc:9890${path}`, {
        method: 'POST',
        headers: { 'x-kj-token': token, 'x-kj-session': SESSION },
        body: JSON.stringify(body),
    })
}

async function error(res: Response): Promise<string> {
    return ((await res.json()) as { error: { code: string } }).error.code
}

describe('SSH through kj-keychain', () => {
    test('the public key of the credential, resolved as its ssh_private_key field', async () => {
        const { handle, resolves } = setup()
        const res = await handle(post(SSH_KEY_PATH, { credential: 'SSH - Delta' }))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ public_key: PUBLIC })
        expect(resolves).toEqual([
            {
                agent_id: 42,
                conversation_session_id: SESSION,
                credential: 'SSH - Delta',
                field: SSH_KEY_FIELD,
            },
        ])
    })

    test('signs, and the private key never comes back', async () => {
        const { handle } = setup()
        const res = await handle(
            post(SSH_SIGN_PATH, {
                credential: 'SSH - Delta',
                public_key: PUBLIC,
                data: Buffer.from('to sign').toString('base64'),
                flags: 0,
            })
        )
        expect(res.status).toBe(200)
        const text = await res.text()
        expect(text).toContain('signature')
        expect(text).not.toContain('PRIVATE KEY')
    })

    test('a key that changed since it was listed is not used', async () => {
        const { handle } = setup()
        const other = generateKeyPairSync('ed25519').privateKey.export({
            format: 'pem',
            type: 'pkcs8',
        }) as string
        const res = await handle(
            post(SSH_SIGN_PATH, {
                credential: 'SSH - Delta',
                public_key: parseSshPrivateKey(other).public_blob.toString('base64'),
                data: 'AAAA',
            })
        )
        expect(res.status).toBe(409)
        expect(await error(res)).toBe('KEYCHAIN_KEY_CHANGED')
    })

    test('without a valid agent token, nothing is resolved', async () => {
        const { handle, resolves } = setup()
        const res = await handle(post(SSH_KEY_PATH, { credential: 'x' }, 'forged'))
        expect(res.status).toBe(401)
        expect(resolves).toHaveLength(0)
    })

    test('the backend refusal goes through as it is', async () => {
        const { handle } = setup({ ok: false, code: 'KEYCHAIN_NO_ACCESS', message: 'm' })
        const res = await handle(post(SSH_KEY_PATH, { credential: 'x' }))
        expect(res.status).toBe(403)
        expect(await error(res)).toBe('KEYCHAIN_NO_ACCESS')
    })

    test('a field that is not an SSH key, and a key with a passphrase, say which', async () => {
        const notKey = await setup({ ok: true, value: 'hunter2', sites: [] }).handle(
            post(SSH_KEY_PATH, { credential: 'x' })
        )
        expect(await error(notKey)).toBe('KEYCHAIN_NOT_SSH_KEY')
        const encrypted = generateKeyPairSync('ed25519').privateKey.export({
            format: 'pem',
            type: 'pkcs8',
            cipher: 'aes-256-cbc',
            passphrase: 'frase',
        }) as string
        const enc = await setup({ ok: true, value: encrypted, sites: [] }).handle(
            post(SSH_KEY_PATH, { credential: 'x' })
        )
        expect(await error(enc)).toBe('KEYCHAIN_KEY_ENCRYPTED')
    })
})
