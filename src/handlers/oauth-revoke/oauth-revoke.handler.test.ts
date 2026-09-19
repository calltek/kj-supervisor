import { afterEach, describe, expect, test } from 'bun:test'
import type { KJLogger } from '../../logger'
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_REVOKE_ENDPOINT } from '../../oauth/constants'
import { OAuthRevokeHandler } from './oauth-revoke.handler'

const logged: unknown[] = []
const fakeLogger = {
    child: () => fakeLogger,
    info: (...args: unknown[]) => logged.push(args),
    error: (...args: unknown[]) => logged.push(args),
    warn: (...args: unknown[]) => logged.push(args),
} as unknown as KJLogger

const realFetch = globalThis.fetch

/** Stands in for Anthropic's revoke endpoint; records what it was sent. */
function stubRevokeEndpoint(status: number, body = '{}') {
    const seen: { url?: string; body?: Record<string, unknown> } = {}
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        seen.url = String(url)
        seen.body = JSON.parse(String(init?.body ?? '{}'))
        return new Response(body, { status })
    }) as typeof fetch
    return seen
}

const TOKEN = 'sk-ant-oat01-secret-value'

afterEach(() => {
    globalThis.fetch = realFetch
    logged.length = 0
})

describe('oauth:revoke', () => {
    test('revokes the access token the way `claude /logout` does', async () => {
        const seen = stubRevokeEndpoint(200)
        const ack = await new OAuthRevokeHandler({ logger: fakeLogger }).handle({
            request_id: 'r1',
            token: TOKEN,
        })

        expect(ack).toEqual({ ok: true })
        expect(seen.url).toBe(CLAUDE_OAUTH_REVOKE_ENDPOINT)
        expect(seen.body).toEqual({
            token: TOKEN,
            token_type_hint: 'access_token',
            client_id: CLAUDE_OAUTH_CLIENT_ID,
        })
    })

    test('a rejection is an error ack, retryable only on 5xx', async () => {
        stubRevokeEndpoint(400, '<html>anything</html>')
        const bad = await new OAuthRevokeHandler({ logger: fakeLogger }).handle({
            request_id: 'r1',
            token: TOKEN,
        })
        expect(bad.ok).toBe(false)
        if (!bad.ok) {
            expect(bad.error.retryable).toBe(false)
            // The status, never the body of whatever answered.
            expect(bad.error.message).toBe('Revoke endpoint returned 400')
        }

        stubRevokeEndpoint(503)
        const down = await new OAuthRevokeHandler({ logger: fakeLogger }).handle({
            request_id: 'r2',
            token: TOKEN,
        })
        expect(!down.ok && down.error.retryable).toBe(true)
    })

    test('an unreachable endpoint is a retryable error', async () => {
        globalThis.fetch = (async () => {
            throw new Error('ECONNRESET')
        }) as unknown as typeof fetch
        const ack = await new OAuthRevokeHandler({ logger: fakeLogger }).handle({
            request_id: 'r1',
            token: TOKEN,
        })
        expect(ack.ok).toBe(false)
        if (!ack.ok) expect(ack.error.retryable).toBe(true)
    })

    test('the token never reaches the logs', async () => {
        stubRevokeEndpoint(200)
        await new OAuthRevokeHandler({ logger: fakeLogger }).handle({
            request_id: 'r1',
            token: TOKEN,
        })
        stubRevokeEndpoint(401)
        await new OAuthRevokeHandler({ logger: fakeLogger }).handle({
            request_id: 'r2',
            token: TOKEN,
        })
        expect(JSON.stringify(logged)).not.toContain('sk-ant-oat01')
    })

    test('without a token nothing is sent', async () => {
        const seen = stubRevokeEndpoint(200)
        const ack = await new OAuthRevokeHandler({ logger: fakeLogger }).handle({
            request_id: 'r1',
            token: '',
        })
        expect(ack.ok).toBe(false)
        expect(seen.url).toBeUndefined()
    })
})
