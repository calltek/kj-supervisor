import { describe, expect, test } from 'bun:test'

import type { KeychainResolveAck } from './control-protocol'
import { type Fetcher, type LookupAll, MAX_BODY_BYTES, createKeychainHandler } from './handler'
import { silentLog } from './log'
import { REDACTED } from './redact'
import { AgentTokenRegistry } from './registry'
import type { ResolveRequest } from './resolver'

const SECRET = 'sk_live_9f8e7d6c5b4a'
const TOKEN = 'agent-token-42'

interface Call {
    url: string
    init: BunFetchRequestInit
}

function setup(
    opts: {
        ack?: KeychainResolveAck
        addresses?: string[]
        respond?: (call: Call) => Response
    } = {}
) {
    const registry = new AgentTokenRegistry()
    registry.set(42, TOKEN)
    const resolves: ResolveRequest[] = []
    const calls: Call[] = []
    const lookups: string[] = []
    const ack: KeychainResolveAck = opts.ack ?? {
        ok: true,
        value: SECRET,
        sites: [{ host: 'stripe.com', subdomains: true }],
    }
    const fetch: Fetcher = async (url, init) => {
        const call = { url, init }
        calls.push(call)
        return opts.respond?.(call) ?? new Response('ok')
    }
    const lookup: LookupAll = async (host) => {
        lookups.push(host)
        return (opts.addresses ?? ['93.184.216.34']).map((address) => ({
            address,
            family: address.includes(':') ? 6 : 4,
        }))
    }
    const handle = createKeychainHandler({
        registry,
        resolve: async (request) => {
            resolves.push(request)
            return ack
        },
        log: silentLog,
        fetch,
        lookup,
    })
    return { handle, resolves, calls, lookups }
}

function req(
    target: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}
) {
    return new Request('http://keychain:9890/r', {
        method: init.method ?? 'GET',
        headers: {
            'X-Kj-Token': TOKEN,
            'X-Kj-Session': 'sess-1',
            'X-Kj-Target': target,
            ...init.headers,
        },
        body: init.body,
    })
}

const AUTH = { Authorization: 'Bearer {{kj:Stripe live.api_key}}' }

async function errorCode(response: Response) {
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(response.headers.get('X-Kj-Keychain-Error')).toBe(body.error.code)
    return body.error
}

describe('keychain handler', () => {
    test('substitutes in the auth header, pins the IP, keeps SNI and Host, hides the echo', async () => {
        const { handle, calls, resolves } = setup({
            respond: ({ init }) => {
                const auth = new Headers(init.headers).get('authorization') ?? ''
                return new Response(`echo ${auth} ${btoa(SECRET)}`, {
                    headers: { 'x-echo': auth, 'content-encoding': 'gzip' },
                })
            },
        })
        const response = await handle(
            req('https://api.stripe.com:8443/v1/charges?limit=1', {
                method: 'POST',
                headers: { ...AUTH, 'Content-Type': 'application/json', Connection: 'close' },
                body: '{"amount":100}',
            })
        )
        expect(response.status).toBe(200)
        expect(resolves).toEqual([
            {
                agent_id: 42,
                conversation_session_id: 'sess-1',
                credential: 'Stripe live',
                field: 'api_key',
            },
        ])

        const call = calls[0]
        expect(call?.url).toBe('https://93.184.216.34:8443/v1/charges?limit=1')
        expect(call?.init.redirect).toBe('manual')
        expect(call?.init.tls?.serverName).toBe('api.stripe.com')
        const sent = new Headers(call?.init.headers)
        expect(sent.get('authorization')).toBe(`Bearer ${SECRET}`)
        expect(sent.get('host')).toBe('api.stripe.com:8443')
        expect(sent.get('content-type')).toBe('application/json')
        for (const name of ['x-kj-token', 'x-kj-session', 'x-kj-target', 'connection']) {
            expect(sent.has(name)).toBe(false)
        }

        const text = await response.text()
        expect(text).toBe(`echo Bearer ${REDACTED} ${REDACTED}`)
        expect(response.headers.get('x-echo')).toBe(`Bearer ${REDACTED}`)
        expect(response.headers.get('content-encoding')).toBeNull()
        expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(text)))
    })

    test('unknown token: 401 and nothing resolved', async () => {
        const { handle, resolves, calls } = setup()
        const request = req('https://api.stripe.com/', { headers: { ...AUTH } })
        request.headers.set('X-Kj-Token', 'nope')
        const response = await handle(request)
        expect(response.status).toBe(401)
        expect((await errorCode(response)).code).toBe('KEYCHAIN_UNAUTHORIZED')
        expect(resolves).toHaveLength(0)
        expect(calls).toHaveLength(0)
    })

    test.each([
        ['the URL', 'https://api.github.com/search?q={{kj:Stripe live.api_key}}', {}, undefined],
        [
            'the URL, percent-encoded',
            'https://api.github.com/search?q=%7B%7Bkj%3AStripe.api_key%7D%7D',
            {},
            undefined,
        ],
        ['the body', 'https://api.github.com/gists', {}, '{"c":"{{kj:Stripe live.api_key}}"}'],
        [
            'another header',
            'https://api.github.com/',
            { 'X-Note': '{{kj:Stripe live.api_key}}' },
            undefined,
        ],
    ])('a reference in %s is refused without going out', async (_, target, headers, body) => {
        const { handle, resolves, calls } = setup()
        const response = await handle(
            req(target, { method: body ? 'POST' : 'GET', headers: { ...AUTH, ...headers }, body })
        )
        expect(response.status).toBe(400)
        expect((await errorCode(response)).code).toBe('KEYCHAIN_REF_OUTSIDE_HEADER')
        expect(resolves).toHaveLength(0)
        expect(calls).toHaveLength(0)
    })

    test('http is refused', async () => {
        const { handle, calls } = setup()
        const response = await handle(req('http://api.stripe.com/', { headers: AUTH }))
        expect((await errorCode(response)).code).toBe('KEYCHAIN_NOT_HTTPS')
        expect(calls).toHaveLength(0)
    })

    test('a name that resolves to ANY private address is refused before resolving', async () => {
        const { handle, resolves, calls } = setup({ addresses: ['8.8.8.8', '169.254.169.254'] })
        const response = await handle(req('https://api.stripe.com/', { headers: AUTH }))
        expect(response.status).toBe(403)
        expect((await errorCode(response)).code).toBe('KEYCHAIN_PRIVATE_ADDRESS')
        expect(resolves).toHaveLength(0)
        expect(calls).toHaveLength(0)
    })

    test('a private IP literal is refused without DNS', async () => {
        const { handle, lookups, calls } = setup()
        for (const target of ['https://127.0.0.1/', 'https://[::ffff:10.0.0.1]/']) {
            const response = await handle(req(target, { headers: AUTH }))
            expect((await errorCode(response)).code).toBe('KEYCHAIN_PRIVATE_ADDRESS')
        }
        expect(lookups).toHaveLength(0)
        expect(calls).toHaveLength(0)
    })

    test('wrong site: 403 naming the sites the credential is bound to', async () => {
        const { handle, calls } = setup()
        const response = await handle(req('https://evil-stripe.com/', { headers: AUTH }))
        expect(response.status).toBe(403)
        const error = await errorCode(response)
        expect(error.code).toBe('KEYCHAIN_WRONG_SITE')
        expect(error.message).toContain('stripe.com')
        expect(error.message).not.toContain(SECRET)
        expect(calls).toHaveLength(0)
    })

    test('every reference must allow the host', async () => {
        const acks: Record<string, KeychainResolveAck> = {
            a: { ok: true, value: 'value-a-123', sites: [{ host: 'x.com', subdomains: false }] },
            b: { ok: true, value: 'value-b-456', sites: [{ host: 'y.com', subdomains: false }] },
        }
        const registry = new AgentTokenRegistry()
        registry.set(42, TOKEN)
        const calls: string[] = []
        const handle = createKeychainHandler({
            registry,
            resolve: async (r) => acks[r.credential] as KeychainResolveAck,
            log: silentLog,
            fetch: async (url) => {
                calls.push(url)
                return new Response('ok')
            },
            lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        })
        const response = await handle(
            req('https://x.com/', {
                headers: { Authorization: 'Bearer {{kj:a.k}}', 'X-API-Key': '{{kj:b.k}}' },
            })
        )
        expect((await errorCode(response)).code).toBe('KEYCHAIN_WRONG_SITE')
        expect(calls).toHaveLength(0)
    })

    test('a backend error is passed through as is', async () => {
        const { handle, calls } = setup({
            ack: { ok: false, code: 'KEYCHAIN_NO_ACCESS', message: 'No puedes usarla.' },
        })
        const response = await handle(req('https://api.stripe.com/', { headers: AUTH }))
        expect(response.status).toBe(403)
        expect(await errorCode(response)).toEqual({
            code: 'KEYCHAIN_NO_ACCESS',
            message: 'No puedes usarla.',
        })
        expect(calls).toHaveLength(0)
    })

    test('a redirect is returned, not followed, and its Location is hidden', async () => {
        const { handle, calls } = setup({
            respond: () =>
                new Response(null, {
                    status: 302,
                    headers: { location: `https://evil.com/?k=${encodeURIComponent(SECRET)}` },
                }),
        })
        const response = await handle(req('https://api.stripe.com/', { headers: AUTH }))
        expect(response.status).toBe(302)
        expect(response.headers.get('location')).toBe(`https://evil.com/?k=${REDACTED}`)
        expect(calls).toHaveLength(1)
    })

    test('a response over 32 MiB is not returned', async () => {
        const { handle } = setup({
            respond: () => new Response(new Uint8Array(MAX_BODY_BYTES + 1)),
        })
        const response = await handle(req('https://api.stripe.com/', { headers: AUTH }))
        expect(response.status).toBe(502)
        expect((await errorCode(response)).code).toBe('KEYCHAIN_RESPONSE_TOO_LARGE')
    })

    test('a request body over 32 MiB is refused', async () => {
        const { handle, calls } = setup()
        const response = await handle(
            req('https://api.stripe.com/', {
                method: 'POST',
                headers: AUTH,
                body: new Uint8Array(MAX_BODY_BYTES + 1),
            })
        )
        expect(response.status).toBe(413)
        expect(calls).toHaveLength(0)
    })

    test('a request without any reference is refused', async () => {
        const { handle, calls } = setup()
        const response = await handle(req('https://api.stripe.com/'))
        expect((await errorCode(response)).code).toBe('KEYCHAIN_NO_REFERENCE')
        expect(calls).toHaveLength(0)
    })
})
