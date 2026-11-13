/**
 * What each running agent is using right now — CPU cores and memory — every
 * few seconds, for the gauges on its page. Push-only and nothing is stored on
 * the way: the control relays it only to whoever has the agent open.
 *
 * Docker's CPU counter is cumulative, so cores in use come from two readings
 * of the same container: Δcpu-time / Δwall-time. The first reading of a
 * container (or of a new one, after a restart: the counter goes back) has no
 * pair and reports `cpu_cores: null`.
 */

import type { KJDocker } from '../../docker/client/client'
import type { KJLogger } from '../../logger'

/** Local until the control's protocol ships it. */
export interface AgentResourcesReport {
    agent_id: number
    cpu_cores: number | null
    memory_mb: number
}

export interface AgentResourcesReporterOptions {
    docker: Pick<KJDocker, 'sampleAgentResources'>
    client: { push(event: string, payload: unknown): void }
    logger: KJLogger
    interval_ms: number
}

export interface AgentResourcesHandle {
    tick(): Promise<void>
    stop(): void
}

export function startAgentResourcesLoop(opts: AgentResourcesReporterOptions): AgentResourcesHandle {
    const log = opts.logger.child({ component: 'agent-resources' })
    const prev = new Map<number, { cpu_total_ns: number; read_ms: number }>()
    let stopped = false
    let running = false

    const tick = async (): Promise<void> => {
        if (stopped || running) return
        running = true
        try {
            const samples = await opts.docker.sampleAgentResources()
            const seen = new Set<number>()
            for (const s of samples) {
                seen.add(s.agent_id)
                const p = prev.get(s.agent_id)
                const dt_ns = p ? (s.read_ms - p.read_ms) * 1e6 : 0
                const dcpu = p ? s.cpu_total_ns - p.cpu_total_ns : -1
                const cpu_cores =
                    p && dt_ns > 0 && dcpu >= 0 ? Math.round((dcpu / dt_ns) * 100) / 100 : null
                prev.set(s.agent_id, { cpu_total_ns: s.cpu_total_ns, read_ms: s.read_ms })
                const report: AgentResourcesReport = {
                    agent_id: s.agent_id,
                    cpu_cores,
                    memory_mb: Math.round(s.memory_bytes / (1024 * 1024)),
                }
                opts.client.push('agent:resources', report)
            }
            for (const id of prev.keys()) if (!seen.has(id)) prev.delete(id)
        } catch (err) {
            log.debug({ err: err instanceof Error ? err.message : String(err) }, 'sample failed')
        } finally {
            running = false
        }
    }

    const timer = setInterval(() => {
        void tick()
    }, opts.interval_ms)

    return {
        tick,
        stop(): void {
            stopped = true
            clearInterval(timer)
        },
    }
}
