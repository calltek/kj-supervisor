import { describe, expect, test } from 'bun:test'

import { KJLogger } from '../../logger'
import type { AgentStatusReport } from '../../protocol'
import { AgentStatusReporter } from '../agent-status/agent-status.reporter'
import { StatusHeartbeat } from './status-heartbeat'

const silentLogger = KJLogger.create('error')

class FakeClient {
    public pushes: Array<{ event: string; payload: unknown }> = []
    push(event: string, payload: unknown): void {
        this.pushes.push({ event, payload })
    }
}

function statuses(client: FakeClient): AgentStatusReport[] {
    return client.pushes
        .filter((p) => p.event === 'agent:status')
        .map((p) => p.payload as AgentStatusReport)
}

describe('StatusHeartbeat', () => {
    test('start() pushes one heartbeat immediately', () => {
        const client = new FakeClient()
        const hb = new StatusHeartbeat({
            reporter: new AgentStatusReporter(client, silentLogger),
            agent_id: 42,
            status: 'SPAWNING',
            initial_last_action: 'pulling image',
            interval_ms: 60_000,
        }).start()

        expect(statuses(client)).toHaveLength(1)
        expect(statuses(client)[0]?.last_action).toBe('pulling image')

        hb.stop()
    })

    test('update() rewrites last_action and pushes immediately', () => {
        const client = new FakeClient()
        const hb = new StatusHeartbeat({
            reporter: new AgentStatusReporter(client, silentLogger),
            agent_id: 42,
            status: 'SPAWNING',
            initial_last_action: 'pulling image',
            interval_ms: 60_000,
        }).start()

        hb.update('layer 1/3 — 50%')
        hb.update('layer 2/3 — 30%')

        const list = statuses(client)
        expect(list).toHaveLength(3)
        expect(list[1]?.last_action).toBe('layer 1/3 — 50%')
        expect(list[2]?.last_action).toBe('layer 2/3 — 30%')

        hb.stop()
    })

    test('stop() halts further pushes', async () => {
        const client = new FakeClient()
        const hb = new StatusHeartbeat({
            reporter: new AgentStatusReporter(client, silentLogger),
            agent_id: 42,
            status: 'STOPPING',
            initial_last_action: 'waiting for grace',
            interval_ms: 5,
        }).start()

        await new Promise((r) => setTimeout(r, 15))
        const count_before_stop = statuses(client).length
        hb.stop()
        await new Promise((r) => setTimeout(r, 30))

        expect(statuses(client).length).toBe(count_before_stop)
    })

    test('start() is idempotent', () => {
        const client = new FakeClient()
        const hb = new StatusHeartbeat({
            reporter: new AgentStatusReporter(client, silentLogger),
            agent_id: 42,
            status: 'SPAWNING',
            initial_last_action: 'x',
            interval_ms: 60_000,
        })
        hb.start()
        hb.start()
        // Two start() calls must not double-fire.
        expect(statuses(client)).toHaveLength(1)
        hb.stop()
    })

    test('last_action_at advances on each push', () => {
        const client = new FakeClient()
        const hb = new StatusHeartbeat({
            reporter: new AgentStatusReporter(client, silentLogger),
            agent_id: 42,
            status: 'SPAWNING',
            initial_last_action: 'x',
            interval_ms: 60_000,
        }).start()

        const t1 = statuses(client)[0]?.last_action_at ?? 0
        // small sleep without timers
        const target = Date.now() + 2
        while (Date.now() < target) {
            /* spin */
        }
        hb.update('y')
        const t2 = statuses(client)[1]?.last_action_at ?? 0

        expect(t2).toBeGreaterThan(t1)
        hb.stop()
    })
})
