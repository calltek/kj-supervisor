import { afterEach, describe, expect, test } from 'bun:test'
import type { KJLogger } from '../../logger'
import { CLAUDE_OAUTH_TOKEN_LIFETIME_S } from '../../oauth/constants'
import { OAuthExchangeHandler } from './oauth-exchange.handler'

const fakeLogger = {
    child: () => fakeLogger,
    info: () => {},
    error: () => {},
    warn: () => {},
} as unknown as KJLogger

const realFetch = globalThis.fetch

/** Stands in for Anthropic's token endpoint; returns the request body it saw. */
function stubTokenEndpoint(response: Record<string, unknown>): {
    body: () => Record<string, unknown>
} {
    let seen: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        seen = JSON.parse(String(init?.body ?? '{}'))
        return new Response(JSON.stringify(response), { status: 200 })
    }) as typeof fetch
    return { body: () => seen }
}

const payload = {
    request_id: 'r1',
    agent_id: 1,
    code: 'abc#state-1',
    code_verifier: 'v'.repeat(43),
    state: 'state-1',
}

afterEach(() => {
    globalThis.fetch = realFetch
})

describe('oauth:exchange', () => {
    test('asks for a one-year token, like `claude setup-token`', async () => {
        const endpoint = stubTokenEndpoint({ access_token: 'tok', expires_in: 31_536_000 })
        const ack = await new OAuthExchangeHandler({ logger: fakeLogger }).handle(payload)

        expect(endpoint.body().expires_in).toBe(CLAUDE_OAUTH_TOKEN_LIFETIME_S)
        expect(CLAUDE_OAUTH_TOKEN_LIFETIME_S).toBe(31_536_000)
        expect(ack).toEqual({ ok: true, access_token: 'tok' })
    })

    test('refuses a token that dies in hours instead of storing it', async () => {
        // What the exchange returned before this fix: an 8 h access token that
        // took the connection down the next morning.
        stubTokenEndpoint({ access_token: 'tok', expires_in: 28_800, refresh_token: 'r' })
        const ack = await new OAuthExchangeHandler({ logger: fakeLogger }).handle(payload)

        expect(ack.ok).toBe(false)
        if (!ack.ok) expect(ack.error.message).toContain('claude setup-token')
    })

    test('an 8 h lifetime sent as a string is refused too', async () => {
        stubTokenEndpoint({ access_token: 'tok', expires_in: '28800' })
        const ack = await new OAuthExchangeHandler({ logger: fakeLogger }).handle(payload)
        expect(ack.ok).toBe(false)
    })

    test('a lifetime that is not a number is refused', async () => {
        stubTokenEndpoint({ access_token: 'tok', expires_in: 'soon' })
        const ack = await new OAuthExchangeHandler({ logger: fakeLogger }).handle(payload)
        expect(ack.ok).toBe(false)
        if (!ack.ok) expect(ack.error.message).toContain('no readable lifetime')
    })

    test('a response without expires_in is still accepted', async () => {
        stubTokenEndpoint({ access_token: 'tok' })
        const ack = await new OAuthExchangeHandler({ logger: fakeLogger }).handle(payload)
        expect(ack.ok).toBe(true)
    })
})
