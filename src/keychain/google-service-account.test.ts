import { describe, expect, test } from 'bun:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'

import {
    GOOGLE_TOKEN_URL,
    GoogleTokenMinter,
    googleGrant,
    parseServiceAccount,
    signAssertion,
} from './google-service-account'
import { type Fetcher, createKeychainHandler } from './handler'
import { silentLog } from './log'
import { AgentTokenRegistry } from './registry'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const KEY_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'vcs',
    private_key_id: 'abc123',
    private_key: PEM,
    client_email: 'bot@vcs.iam.gserviceaccount.com',
    token_uri: 'https://evil.example/token',
})

function decode(part: string) {
    return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>
}

describe('service account key', () => {
    test('recognises the JSON Google hands out, and nothing else', () => {
        expect(parseServiceAccount(KEY_JSON)?.client_email).toBe('bot@vcs.iam.gserviceaccount.com')
        expect(parseServiceAccount('sk_live_123')).toBeNull()
        expect(parseServiceAccount('{"type":"authorized_user"}')).toBeNull()
        expect(parseServiceAccount('{not json')).toBeNull()
    })

    test('signs an RS256 assertion for Google, with scopes and subject', () => {
        const key = parseServiceAccount(KEY_JSON)
        if (!key) throw new Error('no key')
        const jwt = signAssertion(
            key,
            { scopes: ['https://mail.google.com/'], subject: 'reservas@vcs.com' },
            1_700_000_000_000
        )
        const [h, c, s] = jwt.split('.')
        expect(decode(h ?? '')).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'abc123' })
        expect(decode(c ?? '')).toEqual({
            iss: 'bot@vcs.iam.gserviceaccount.com',
            scope: 'https://mail.google.com/',
            aud: GOOGLE_TOKEN_URL,
            iat: 1_700_000_000,
            exp: 1_700_003_600,
            sub: 'reservas@vcs.com',
        })
        const verify = createVerify('RSA-SHA256')
        verify.update(`${h}.${c}`)
        expect(verify.verify(publicKey, Buffer.from(s ?? '', 'base64url'))).toBe(true)
    })

    test('scopes default to cloud-platform; anything not a Google scope is refused', () => {
        expect(googleGrant(new Headers()).scopes).toEqual([
            'https://www.googleapis.com/auth/cloud-platform',
        ])
        const grant = googleGrant(
            new Headers({
                'X-Kj-Google-Scopes':
                    'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
                'X-Kj-Google-Subject': 'reservas@vcs.com',
            })
        )
        expect(grant.scopes).toHaveLength(2)
        expect(grant.subject).toBe('reservas@vcs.com')
        expect(() => googleGrant(new Headers({ 'X-Kj-Google-Scopes': 'https://evil/x' }))).toThrow()
        expect(() => googleGrant(new Headers({ 'X-Kj-Google-Subject': 'nope' }))).toThrow()
    })

    test('mints once and reuses the token until shortly before it expires', async () => {
        let now = 0
        const calls: string[] = []
        const minter = new GoogleTokenMinter(
            async (url) => {
                calls.push(url)
                return Response.json({ access_token: `ya29.t${calls.length}`, expires_in: 3600 })
            },
            () => now
        )
        const key = parseServiceAccount(KEY_JSON)
        if (!key) throw new Error('no key')
        const grant = { scopes: ['https://mail.google.com/'], subject: null }
        expect(await minter.token(key, grant)).toBe('ya29.t1')
        expect(await minter.token(key, grant)).toBe('ya29.t1')
        now = 56 * 60_000
        expect(await minter.token(key, grant)).toBe('ya29.t2')
        expect(calls).toEqual([GOOGLE_TOKEN_URL, GOOGLE_TOKEN_URL])
    })

    test('a refusal from Google says why, without the key', async () => {
        const minter = new GoogleTokenMinter(async () =>
            Response.json(
                { error: 'unauthorized_client', error_description: 'Client is unauthorized' },
                { status: 401 }
            )
        )
        const key = parseServiceAccount(KEY_JSON)
        if (!key) throw new Error('no key')
        const error = await minter
            .token(key, { scopes: ['https://mail.google.com/'], subject: 'a@b.com' })
            .catch((e: Error & { code?: string }) => e)
        expect((error as { code?: string }).code).toBe('KEYCHAIN_GOOGLE_TOKEN_FAILED')
        expect((error as Error).message).toContain('unauthorized_client')
        expect((error as Error).message).not.toContain('PRIVATE KEY')
    })
})

describe('keychain handler with a service account', () => {
    function setup(sites = [{ host: 'googleapis.com', subdomains: true }]) {
        const registry = new AgentTokenRegistry()
        registry.set(42, 'tok')
        const calls: { url: string; init: BunFetchRequestInit }[] = []
        const fetch: Fetcher = async (url, init) => {
            calls.push({ url, init })
            if (url === GOOGLE_TOKEN_URL) {
                return Response.json({ access_token: 'ya29.minted', expires_in: 3600 })
            }
            return new Response(`echo ${new Headers(init.headers).get('authorization')}`)
        }
        const handle = createKeychainHandler({
            registry,
            resolve: async () => ({ ok: true, value: KEY_JSON, sites }),
            log: silentLog,
            fetch,
            lookup: async () => [{ address: '142.250.1.1', family: 4 }],
        })
        const request = (target: string, headers: Record<string, string> = {}) =>
            new Request('http://keychain:9890/r', {
                headers: {
                    'X-Kj-Token': 'tok',
                    'X-Kj-Session': 's',
                    'X-Kj-Target': target,
                    Authorization: 'Bearer {{kj:Google - reservas.clave}}',
                    ...headers,
                },
            })
        return { handle, calls, request }
    }

    test('sends a fresh access token, never the key, and hides it in the answer', async () => {
        const { handle, calls, request } = setup()
        const response = await handle(
            request('https://sheets.googleapis.com/v4/spreadsheets/x', {
                'X-Kj-Google-Scopes': 'https://www.googleapis.com/auth/spreadsheets',
                'X-Kj-Google-Subject': 'reservas@vcs.com',
            })
        )
        expect(response.status).toBe(200)
        expect(calls[0]?.url).toBe(GOOGLE_TOKEN_URL)
        const sent = new Headers(calls[1]?.init.headers)
        expect(sent.get('authorization')).toBe('Bearer ya29.minted')
        expect(sent.has('x-kj-google-scopes')).toBe(false)
        expect(sent.has('x-kj-google-subject')).toBe(false)
        expect(await response.text()).not.toContain('ya29.minted')
    })

    test('not to a host outside googleapis.com, even if it is a destination', async () => {
        const { handle, calls, request } = setup([
            { host: 'googleapis.com', subdomains: true },
            { host: 'evil.com', subdomains: true },
        ])
        const response = await handle(request('https://evil.com/steal'))
        expect(response.status).toBe(403)
        expect(calls).toHaveLength(0)
    })
})
