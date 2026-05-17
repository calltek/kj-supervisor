/**
 * Periodic `server:metrics` push to the control. Snapshots the host's
 * load avg (1-minute, normalized by core count so 1.0 means "fully
 * loaded") and uptime in seconds. The control persists it as the
 * latest snapshot on Server — no time-series in MVP.
 */

import { cpus, loadavg, uptime } from 'node:os'

import type { KJLogger } from '../../logger'
import type { ServerMetricsPayload } from '../../protocol'

export interface ServerMetricsClient {
    emitWithAck<T>(event: string, payload: unknown, timeoutMs: number): Promise<T>
}

export interface ServerMetricsReporterOptions {
    client: ServerMetricsClient
    logger: KJLogger
    interval_ms: number
    ack_timeout_ms?: number
}

export interface ServerMetricsHandle {
    /** Drive one tick manually (tests). */
    tick(): Promise<void>
    stop(): void
}

export function startServerMetricsLoop(opts: ServerMetricsReporterOptions): ServerMetricsHandle {
    const log = opts.logger.child({ component: 'server-metrics' })
    const ack_timeout_ms = opts.ack_timeout_ms ?? 5_000
    const core_count = Math.max(1, cpus().length)

    let stopped = false

    const tick = async (): Promise<void> => {
        if (stopped) return

        const [load_1m] = loadavg()
        const payload: ServerMetricsPayload = {
            load: (load_1m ?? 0) / core_count,
            uptime_seconds: Math.round(uptime()),
        }

        try {
            await opts.client.emitWithAck<{ ok: boolean }>(
                'server:metrics',
                payload,
                ack_timeout_ms
            )
            log.debug({ payload }, 'server:metrics sent')
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            log.warn({ error: message }, 'server:metrics failed (will retry next tick)')
        }
    }

    const timer = setInterval(() => {
        void tick()
    }, opts.interval_ms)
    // Fire one immediately so the control sees a fresh snapshot at boot.
    void tick()

    return {
        tick,
        stop(): void {
            stopped = true
            clearInterval(timer)
        },
    }
}
