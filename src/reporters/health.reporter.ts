/**
 * Periodic `health:ping` loop. The control bumps `last_seen_at` on
 * every successful pong; missing N consecutive pings forces the
 * socket to disconnect so Socket.IO restarts its reconnection cycle.
 */

import type { HealthPingPayload, HealthPongAck } from '../protocol'
import type { KJLogger } from '../logger'

export interface HealthClient {
    emitWithAck<T>(event: string, payload: unknown, timeoutMs: number): Promise<T>
    forceReconnect(reason: string): void
}

export interface HealthLoopOptions {
    client: HealthClient
    logger: KJLogger
    interval_ms: number
    /** ms to wait for a pong before counting the ping as failed. */
    ack_timeout_ms?: number
    /** Number of consecutive failed pings that triggers a disconnect. */
    max_failures?: number
}

export interface HealthLoopHandle {
    /** Drive one ping/pong cycle manually. Useful for tests. */
    tick(): Promise<void>
    stop(): void
}

export function startHealthLoop(opts: HealthLoopOptions): HealthLoopHandle {
    const log = opts.logger.child({ component: 'health' })
    const ack_timeout_ms = opts.ack_timeout_ms ?? 5000
    const max_failures = opts.max_failures ?? 3

    let consecutive_failures = 0
    let stopped = false

    const tick = async (): Promise<void> => {
        if (stopped) return

        const payload: HealthPingPayload = { timestamp: Date.now() }
        try {
            const pong = await opts.client.emitWithAck<HealthPongAck>(
                'health:ping',
                payload,
                ack_timeout_ms
            )
            consecutive_failures = 0
            log.debug({ server_time: pong.server_time }, 'pong')
        } catch (err) {
            consecutive_failures += 1
            const message = err instanceof Error ? err.message : String(err)
            log.warn({ error: message, consecutive_failures, max_failures }, 'health:ping failed')

            if (consecutive_failures >= max_failures) {
                log.error(
                    { consecutive_failures, max_failures },
                    'max ping failures reached, forcing reconnect'
                )
                opts.client.forceReconnect(
                    `${consecutive_failures} consecutive health:ping failures`
                )
                // Reset so we don't trigger another reconnect on the very next tick
                // before the new connection has had a chance to handshake.
                consecutive_failures = 0
            }
        }
    }

    const timer = setInterval(() => {
        void tick()
    }, opts.interval_ms)
    // Fire one immediately so we don't wait `interval_ms` for the first heartbeat.
    void tick()

    return {
        tick,
        stop(): void {
            stopped = true
            clearInterval(timer)
        },
    }
}
