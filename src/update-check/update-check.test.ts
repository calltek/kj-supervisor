import { describe, expect, test } from 'bun:test'

import {
    ACK_TIMEOUT_MS,
    FAILED_RETRY_MS,
    MAX_RETRY_MS,
    MIN_RETRY_MS,
    startUpdateCheckLoop,
    type UpdateCheckOptions,
} from './update-check'

interface FakeTimer {
    fn: () => void
    ms: number
    cleared: boolean
}

function harness(acks: unknown[], revision: string | null | undefined = 'abc123') {
    const timers: FakeTimer[] = []
    const calls: Array<{ event: string; payload: unknown; timeout: number }> = []
    const queue = [...acks]
    const noop = () => {}
    const opts: UpdateCheckOptions = {
        revision,
        logger: { debug: noop, info: noop },
        random: () => 0.5,
        setTimer: (fn, ms) => {
            const t = { fn, ms, cleared: false }
            timers.push(t)
            return t
        },
        clearTimer: (h) => {
            ;(h as FakeTimer).cleared = true
        },
        emitWithAck: (async (event: string, payload: unknown, timeout: number) => {
            calls.push({ event, payload, timeout })
            const next = queue.shift()
            if (next instanceof Error) throw next
            return next
        }) as UpdateCheckOptions['emitWithAck'],
    }
    return { opts, timers, calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('bucle de update check', () => {
    test('el primer check va retrasado y no sale antes', () => {
        const h = harness([])
        startUpdateCheckLoop(h.opts)
        expect(h.calls).toHaveLength(0)
        expect(h.timers).toHaveLength(1)
        expect(h.timers[0]?.ms).toBe(150_000)
    })

    test('reprograma según el ack, con topes', async () => {
        const h = harness([
            { action: 'none', retry_after_ms: 7_200_000 },
            { action: 'wait', retry_after_ms: 1 },
            { action: 'none', retry_after_ms: 999_999_999_999 },
        ])
        startUpdateCheckLoop(h.opts)
        h.timers[0]?.fn()
        await tick()
        expect(h.calls[0]).toEqual({
            event: 'server:update:check',
            payload: { revision: 'abc123' },
            timeout: ACK_TIMEOUT_MS,
        })
        expect(h.timers[1]?.ms).toBe(7_200_000)
        h.timers[1]?.fn()
        await tick()
        expect(h.timers[2]?.ms).toBe(MIN_RETRY_MS)
        h.timers[2]?.fn()
        await tick()
        expect(h.timers[3]?.ms).toBe(MAX_RETRY_MS)
    })

    test('con update deja de preguntar', async () => {
        const h = harness([{ action: 'update', retry_after_ms: 60_000 }])
        startUpdateCheckLoop(h.opts)
        h.timers[0]?.fn()
        await tick()
        expect(h.timers).toHaveLength(1)
    })

    test('stop cancela el temporizador pendiente', () => {
        const h = harness([])
        const handle = startUpdateCheckLoop(h.opts)
        handle.stop()
        expect(h.timers[0]?.cleared).toBe(true)
    })

    test('stop con un ack en vuelo no reprograma', async () => {
        const h = harness([{ action: 'none', retry_after_ms: 120_000 }])
        const handle = startUpdateCheckLoop(h.opts)
        h.timers[0]?.fn()
        handle.stop()
        await tick()
        expect(h.timers).toHaveLength(1)
    })

    test('sin revisión no pregunta ni programa nada', () => {
        for (const rev of [null, '']) {
            const h = harness([], rev)
            startUpdateCheckLoop(h.opts)
            expect(h.timers).toHaveLength(0)
            expect(h.calls).toHaveLength(0)
        }
    })

    test('backend viejo (el ack falla): reintento a las 6 h', async () => {
        const h = harness([new Error('ack timeout')])
        startUpdateCheckLoop(h.opts)
        h.timers[0]?.fn()
        await tick()
        expect(h.timers[1]?.ms).toBe(FAILED_RETRY_MS)
    })
})
