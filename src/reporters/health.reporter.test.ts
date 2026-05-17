import { describe, expect, test } from 'bun:test'

import { KJLogger } from '../logger'
import { type HealthClient, startHealthLoop } from './health.reporter'

const silentLogger = KJLogger.create('error')

type AckResult = { ok: true; pong: unknown } | { ok: false; error: unknown }

class FakeClient implements HealthClient {
    public emit_calls = 0
    public force_reconnect_calls = 0
    public next_results: AckResult[] = []

    async emitWithAck<T>(event: string, _payload: unknown, _timeoutMs: number): Promise<T> {
        expect(event).toBe('health:ping')
        this.emit_calls += 1
        const result = this.next_results.shift()
        if (!result) throw new Error('no more results queued')
        if (result.ok) return result.pong as T
        throw result.error
    }

    forceReconnect(_reason: string): void {
        this.force_reconnect_calls += 1
    }
}

/**
 * Stop the loop and wait long enough for any in-flight async ticks to
 * settle so subsequent assertions see a stable counter. We avoid wall
 * clock timing in the actual assertions — we drive cycles via tick().
 */
async function quiesce(): Promise<void> {
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
}

describe('startHealthLoop', () => {
    test('emits a ping immediately on start', async () => {
        const client = new FakeClient()
        client.next_results.push({ ok: true, pong: { pong: true, server_time: 123 } })

        const handle = startHealthLoop({
            client,
            logger: silentLogger,
            // Long interval so only the immediate fire-once shot is counted.
            interval_ms: 60_000,
        })

        await quiesce()
        handle.stop()

        expect(client.emit_calls).toBe(1)
        expect(client.force_reconnect_calls).toBe(0)
    })

    test('disconnects after N consecutive failures', async () => {
        const client = new FakeClient()
        const failure = new Error('ack timeout')
        client.next_results.push(
            { ok: false, error: failure },
            { ok: false, error: failure },
            { ok: false, error: failure }
        )

        const handle = startHealthLoop({
            client,
            logger: silentLogger,
            interval_ms: 60_000,
            max_failures: 3,
        })
        await quiesce()
        await handle.tick()
        await handle.tick()
        handle.stop()

        expect(client.emit_calls).toBe(3)
        expect(client.force_reconnect_calls).toBe(1)
    })

    test('resets the failure counter after a successful pong', async () => {
        const client = new FakeClient()
        const failure = new Error('ack timeout')
        client.next_results.push(
            { ok: false, error: failure },
            { ok: false, error: failure },
            { ok: true, pong: { pong: true, server_time: 1 } },
            { ok: false, error: failure },
            { ok: false, error: failure }
        )

        const handle = startHealthLoop({
            client,
            logger: silentLogger,
            interval_ms: 60_000,
            max_failures: 3,
        })
        await quiesce()
        await handle.tick()
        await handle.tick()
        await handle.tick()
        await handle.tick()
        handle.stop()

        // 2 fails + reset + 2 fails: never hits 3 in a row.
        expect(client.emit_calls).toBe(5)
        expect(client.force_reconnect_calls).toBe(0)
    })

    test('stop() halts further ticks', async () => {
        const client = new FakeClient()
        client.next_results.push({ ok: true, pong: { pong: true, server_time: 1 } })

        const handle = startHealthLoop({
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })
        await quiesce()
        handle.stop()

        const calls_at_stop = client.emit_calls
        await handle.tick()
        await handle.tick()

        expect(client.emit_calls).toBe(calls_at_stop)
    })
})
