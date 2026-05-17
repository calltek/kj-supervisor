import { describe, expect, test } from 'bun:test'

import { KJLogger } from '../logger'
import { startServerMetricsLoop } from './server-metrics.reporter'

const silentLogger = KJLogger.create('error')

class FakeClient {
    public emit_calls: Array<{ event: string; payload: unknown }> = []
    public next_error: Error | null = null

    async emitWithAck<T>(event: string, payload: unknown, _timeoutMs: number): Promise<T> {
        this.emit_calls.push({ event, payload })
        if (this.next_error) throw this.next_error
        return { ok: true } as T
    }
}

describe('startServerMetricsLoop', () => {
    test('emits server:metrics with load and uptime fields', async () => {
        const client = new FakeClient()
        const handle = startServerMetricsLoop({
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })

        // Immediate fire-on-boot.
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
        handle.stop()

        expect(client.emit_calls).toHaveLength(1)
        const call = client.emit_calls[0]
        expect(call?.event).toBe('server:metrics')
        const payload = call?.payload as { load?: number; uptime_seconds?: number }
        expect(typeof payload.load).toBe('number')
        expect(typeof payload.uptime_seconds).toBe('number')
        expect(payload.uptime_seconds).toBeGreaterThan(0)
        expect(payload.load).toBeGreaterThanOrEqual(0)
    })

    test('swallows ack errors and keeps running', async () => {
        const client = new FakeClient()
        client.next_error = new Error('control timed out')
        const handle = startServerMetricsLoop({
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })

        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))

        // No throw, no crash — the ack failure was caught.
        await handle.tick()
        handle.stop()

        expect(client.emit_calls.length).toBeGreaterThanOrEqual(2)
    })

    test('stop() halts further ticks', async () => {
        const client = new FakeClient()
        const handle = startServerMetricsLoop({
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })
        await new Promise((r) => setImmediate(r))
        handle.stop()
        const before = client.emit_calls.length
        await handle.tick()
        await handle.tick()
        expect(client.emit_calls.length).toBe(before)
    })
})
