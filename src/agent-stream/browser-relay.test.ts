import { describe, expect, test } from 'bun:test'

import { KJLogger } from '../logger'
import { BrowserRelay } from './browser-relay'

function setup(opts: { stream?: boolean } = {}) {
    const writes: Array<{ agent_id: number; envelope: Record<string, unknown> }> = []
    const pushes: Array<{ event: string; payload: Record<string, unknown> }> = []
    const relay = new BrowserRelay({
        write: (agent_id, envelope) => {
            writes.push({ agent_id, envelope })
            return opts.stream !== false
        },
        push: (event, payload) =>
            pushes.push({ event, payload: payload as Record<string, unknown> }),
        logger: KJLogger.create('error'),
    })
    return { relay, writes, pushes }
}

const action = {
    agent_id: 1,
    user_id: 7,
    profile: { mode: 'shared' as const },
    request: { kind: 'browser.navigate', url: 'https://example.com', session: 'c1' },
    budget_ms: 5_000,
}

describe('BrowserRelay', () => {
    test("an action is answered by its agent's result, and only by its agent", async () => {
        const s = setup()
        const pending = s.relay.action(action)
        const id = s.writes[0]?.envelope.id as string
        expect(s.writes[0]?.envelope).toMatchObject({ type: 'browser', user_id: 7 })
        // Another agent naming the same id answers nothing.
        s.relay.onContainerLine(2, {
            kj_channel: 'browser',
            kind: 'result',
            id,
            outcome: { status: 'ok' },
        })
        s.relay.onContainerLine(1, {
            kj_channel: 'browser',
            kind: 'result',
            id,
            outcome: { status: 'denied', code: 'HOST_BROWSER_APPROVAL', extra: 'x' },
        })
        expect(await pending).toEqual({ status: 'denied', code: 'HOST_BROWSER_APPROVAL' })
    })

    test('no stream, or no answer in time, fails instead of hanging', async () => {
        expect(await setup({ stream: false }).relay.action(action)).toMatchObject({
            code: 'AGENT_NOT_RUNNING',
        })
        const s = setup()
        const pending = s.relay.action({ ...action, budget_ms: 1_000 })
        expect(await pending).toMatchObject({ code: 'HOST_BROWSER_TIMEOUT' })
    })

    test('an agent that stops answers what it had pending', async () => {
        const s = setup()
        const pending = s.relay.action(action)
        s.relay.onDetach(1)
        expect(await pending).toMatchObject({ code: 'AGENT_NOT_RUNNING' })
    })

    test('only frames, state and closed go up, stamped with the agent that sent them', () => {
        const s = setup()
        s.relay.onContainerLine(3, {
            kj_channel: 'browser',
            kind: 'frame',
            user_id: 7,
            agent_id: 9,
            data: 'j',
        })
        s.relay.onContainerLine(3, { kj_channel: 'browser', kind: 'mcp:request', user_id: 7 })
        s.relay.onContainerLine(3, { kj_channel: 'browser', kind: 'state', user_id: 0 })
        expect(s.pushes).toEqual([
            { event: 'agent:browser:frame', payload: { user_id: 7, agent_id: 3, data: 'j' } },
        ])
    })

    test('a control from the person reaches the stdin as browser_control', () => {
        const s = setup()
        expect(s.relay.control({ agent_id: 1, user_id: 7, op: 'view', type: 'input' })).toBe(true)
        expect(s.writes[0]).toEqual({
            agent_id: 1,
            envelope: { user_id: 7, op: 'view', type: 'browser_control' },
        })
        expect(s.relay.control({ agent_id: 1, user_id: -1, op: 'view' })).toBe(false)
    })
})
