import { describe, expect, test } from 'bun:test'

import { ControlSessions, REPLACED_CLOSE_CODE, isAuthorizedControl } from './control'
import type { KeychainControlUp } from './control-protocol'
import { silentLog } from './log'
import { AgentTokenRegistry } from './registry'
import { ControlLink, ResolveCache } from './resolver'

const REQUEST = {
    agent_id: 1,
    conversation_session_id: 's',
    credential: 'Stripe',
    field: 'api_key',
}

function fakeSocket() {
    const sent: KeychainControlUp[] = []
    const closed: number[] = []
    return {
        sent,
        closed,
        send: (data: string) => sent.push(JSON.parse(data)),
        close: (code?: number) => closed.push(code ?? 0),
    }
}

function setup(timeoutMs = 50) {
    const registry = new AgentTokenRegistry()
    const link = new ControlLink(timeoutMs)
    const cache = new ResolveCache()
    const sessions = new ControlSessions({
        secret: 's3cret',
        registry,
        link,
        cache,
        log: silentLog,
    })
    return { registry, link, cache, sessions }
}

describe('control channel', () => {
    test('bearer secret', () => {
        expect(isAuthorizedControl('Bearer s3cret', 's3cret')).toBe(true)
        expect(isAuthorizedControl('Bearer s3cre', 's3cret')).toBe(false)
        expect(isAuthorizedControl('s3cret', 's3cret')).toBe(false)
        expect(isAuthorizedControl(null, 's3cret')).toBe(false)
    })

    test('tokens: reset, rotate and forget', () => {
        const { registry, sessions } = setup()
        const ws = fakeSocket()
        sessions.open(ws)
        sessions.message(
            ws,
            JSON.stringify({ type: 'agents:reset', agents: [{ agent_id: 1, token: 'a' }] })
        )
        expect(registry.agentFor('a')).toBe(1)
        sessions.message(ws, JSON.stringify({ type: 'agent:token', agent_id: 1, token: 'b' }))
        expect(registry.agentFor('a')).toBeNull()
        expect(registry.agentFor('b')).toBe(1)
        sessions.message(ws, JSON.stringify({ type: 'agent:forget', agent_id: 1 }))
        expect(registry.agentFor('b')).toBeNull()
    })

    test('resolve round trip', async () => {
        const { link, sessions } = setup()
        const ws = fakeSocket()
        sessions.open(ws)
        const pending = link.resolve(REQUEST)
        const up = ws.sent[0]
        expect(up).toMatchObject({ type: 'resolve', ...REQUEST })
        sessions.message(
            ws,
            JSON.stringify({
                type: 'resolve:result',
                id: up?.id,
                ack: { ok: true, value: 'v', sites: [] },
            })
        )
        expect(await pending).toEqual({ ok: true, value: 'v', sites: [] })
    })

    test('no supervisor, timeout and replaced connection → KEYCHAIN_UNAVAILABLE', async () => {
        const { link, sessions } = setup()
        expect((await link.resolve(REQUEST)).ok).toBe(false)

        const first = fakeSocket()
        sessions.open(first)
        const timedOut = await link.resolve(REQUEST)
        expect(timedOut).toMatchObject({ ok: false, code: 'KEYCHAIN_UNAVAILABLE' })

        const inFlight = link.resolve(REQUEST)
        const second = fakeSocket()
        sessions.open(second)
        expect(await inFlight).toMatchObject({ ok: false, code: 'KEYCHAIN_UNAVAILABLE' })
        expect(first.closed).toEqual([REPLACED_CLOSE_CODE])
        // The replaced socket can no longer change anything.
        sessions.message(first, JSON.stringify({ type: 'agent:token', agent_id: 9, token: 'x' }))
        sessions.close(first)
        expect(link.connected()).toBe(true)
    })

    test('cache keeps successes only, per (agent, session, credential, field)', async () => {
        let now = 0
        const cache = new ResolveCache(60_000, () => now)
        let calls = 0
        let ok = false
        const resolve = cache.wrap(async () => {
            calls++
            return ok
                ? { ok: true, value: 'v', sites: [] }
                : { ok: false, code: 'KEYCHAIN_NO_ACCESS', message: 'no' }
        })
        await resolve(REQUEST)
        await resolve(REQUEST)
        expect(calls).toBe(2)
        ok = true
        await resolve(REQUEST)
        await resolve(REQUEST)
        expect(calls).toBe(3)
        await resolve({ ...REQUEST, conversation_session_id: 'other' })
        expect(calls).toBe(4)
        now = 60_001
        await resolve(REQUEST)
        expect(calls).toBe(5)
        cache.forgetAgent(1)
        await resolve(REQUEST)
        expect(calls).toBe(6)
    })
})
