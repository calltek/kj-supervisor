/**
 * Periodic `agent:metrics` push for every running kj-agent container.
 * Fire-and-forget (no ack in the protocol).
 *
 * Today the supervisor only knows `uptime_seconds` — tokens_used and
 * cost_micro are reported as "0" because the inner agent process
 * doesn't expose a token counter yet. The fields are still emitted so
 * the control can persist a baseline and so the wire shape never
 * changes when token reporting lands.
 */

import type { KJContainerSummary, KJDocker } from '../../docker/client/client'
import type { KJLogger } from '../../logger'
import type { AgentMetricsReport } from '../../protocol'

export interface AgentMetricsClient {
    push(event: string, payload: unknown): void
}

export interface AgentMetricsReporterOptions {
    docker: KJDocker
    client: AgentMetricsClient
    logger: KJLogger
    interval_ms: number
}

export interface AgentMetricsHandle {
    /** Drive one tick manually (tests). */
    tick(): Promise<void>
    stop(): void
}

export function startAgentMetricsLoop(opts: AgentMetricsReporterOptions): AgentMetricsHandle {
    const log = opts.logger.child({ component: 'agent-metrics' })
    let stopped = false

    const tick = async (): Promise<void> => {
        if (stopped) return

        let containers: KJContainerSummary[]
        try {
            containers = await opts.docker.listKjContainers()
        } catch (err) {
            log.warn({ err: errMessage(err) }, 'failed to list containers; skipping tick')
            return
        }

        for (const c of containers) {
            if (c.agent_id == null) continue
            try {
                const info = await opts.docker.inspect(c.container_id)
                const started_at = info.State?.StartedAt
                const uptime_seconds = started_at ? secondsSince(started_at) : 0
                // Only report when the container is actually running. A
                // stopped/exited one will surface via the events watcher
                // or the next reconciliation pass — metrics for it would
                // be misleading.
                if (!info.State?.Running) continue

                const report: AgentMetricsReport = {
                    agent_id: c.agent_id,
                    tokens_used: '0',
                    cost_micro: '0',
                    uptime_seconds,
                }
                opts.client.push('agent:metrics', report)
                log.debug({ report }, 'agent:metrics pushed')
            } catch (err) {
                log.warn(
                    { agent_id: c.agent_id, err: errMessage(err) },
                    'failed to inspect container; skipping this one'
                )
            }
        }
    }

    const timer = setInterval(() => {
        void tick()
    }, opts.interval_ms)
    // Don't fire-on-boot here: at boot the events watcher hasn't told
    // us anything yet and the loop will tick naturally within interval_ms.

    return {
        tick,
        stop(): void {
            stopped = true
            clearInterval(timer)
        },
    }
}

function secondsSince(iso: string): number {
    const t = Date.parse(iso)
    if (Number.isNaN(t)) return 0
    return Math.max(0, Math.round((Date.now() - t) / 1000))
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
