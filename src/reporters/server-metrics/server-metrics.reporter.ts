/**
 * Periodic `server:metrics` push to the control. Snapshots:
 *  - load avg (1-minute, normalized by core count so 1.0 = "fully loaded")
 *  - uptime in seconds
 *  - cpu_percent: aggregated CPU usage between ticks (0..100)
 *  - ram_percent: used / total memory (0..100)
 *
 * The control persists the latest snapshot on Server — no time-series
 * in MVP.
 */

import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'

import type { KJLogger } from '../../logger'
import type { ServerMetricsPayload } from '../../protocol'

interface CpuSnapshot {
    idle: number
    total: number
}

function snapshotCpu(): CpuSnapshot {
    let idle = 0
    let total = 0
    for (const cpu of cpus()) {
        for (const value of Object.values(cpu.times)) {
            total += value
        }
        idle += cpu.times.idle
    }
    return { idle, total }
}

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
    // Baseline for the delta-based cpu_percent calculation. The first
    // tick reports null (we need two snapshots to know how much idle
    // vs busy time passed); subsequent ticks compare to the previous
    // snapshot and immediately update it.
    let previous_cpu: CpuSnapshot | null = snapshotCpu()

    const tick = async (): Promise<void> => {
        if (stopped) return

        const [load_1m] = loadavg()

        // cpu_percent — busy ticks since previous snapshot divided by
        // total ticks since previous snapshot. Skipped on first tick.
        let cpu_percent: number | undefined
        const current_cpu = snapshotCpu()
        if (previous_cpu) {
            const idle_delta = current_cpu.idle - previous_cpu.idle
            const total_delta = current_cpu.total - previous_cpu.total
            if (total_delta > 0) {
                cpu_percent = Math.max(
                    0,
                    Math.min(100, ((total_delta - idle_delta) / total_delta) * 100)
                )
            }
        }
        previous_cpu = current_cpu

        // ram_percent — (total - free) / total. Note: free excludes
        // caches on Linux so this slightly overstates real pressure.
        // Good enough for MVP; switch to MemAvailable later if needed.
        const total_ram = totalmem()
        const ram_percent = total_ram > 0 ? ((total_ram - freemem()) / total_ram) * 100 : undefined

        const payload: ServerMetricsPayload = {
            load: (load_1m ?? 0) / core_count,
            uptime_seconds: Math.round(uptime()),
            cpu_percent,
            ram_percent,
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
