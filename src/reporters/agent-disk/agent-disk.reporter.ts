/**
 * The agents' disk ceiling, enforced by watching (decided 2026-11-12).
 *
 * A hard ceiling needs the whole Docker of the machine on XFS with project
 * quotas, and the machine may run the client's own services: Kujira doesn't
 * touch what isn't its own. So every minute this loop measures each running
 * agent that has a ceiling (label `so.kujira.disk-gb`, tenancy.ts) — its
 * named volumes and its writable layer — and:
 *  - reports it (`agent:disk`), so the panel shows it and the control warns
 *    at 80 % (`level: 'warn'`);
 *  - stops the agent at 100 % (`level: 'full'`), as ERROR with
 *    `disk_limit_reached`. It won't start again while it's full (client.ts
 *    `assertDiskRoom`).
 *
 * Not hard: between two measures an agent can go past its ceiling. A minute
 * is the price of not moving the client's Docker; where the host already has
 * project quotas, XFS caps it as well.
 */

import type { KJDocker } from '../../docker/client/client'
import { type DiskLevel, diskLevel } from '../../docker/client/tenancy'
import type { OperationTracker } from '../../docker/operation-tracker/operation-tracker'
import type { KJLogger } from '../../logger'
import type { AgentStatusReporter } from '../agent-status/agent-status.reporter'

/** Pushed every tick for each measured agent. Local until the control's protocol ships it. */
export interface AgentDiskReport {
    agent_id: number
    used_mb: number
    limit_mb: number
    level: DiskLevel
}

export interface AgentDiskClient {
    push(event: string, payload: unknown): void
}

export interface AgentDiskReporterOptions {
    docker: Pick<
        KJDocker,
        'listDiskLimitedAgents' | 'measureVolumes' | 'stopContainer' | 'removeContainer'
    >
    client: AgentDiskClient
    status: Pick<AgentStatusReporter, 'push'>
    tracker: Pick<OperationTracker, 'track' | 'untrack'>
    logger: KJLogger
    interval_ms: number
}

export interface AgentDiskHandle {
    /** Drive one tick manually (tests). */
    tick(): Promise<void>
    stop(): void
}

const MB = 1024 * 1024

export function startAgentDiskLoop(opts: AgentDiskReporterOptions): AgentDiskHandle {
    const log = opts.logger.child({ component: 'agent-disk' })
    let stopped = false
    let running = false

    const stopFull = async (agent_id: number, container_id: string, report: AgentDiskReport) => {
        log.warn(report, 'agent at its disk ceiling — stopping it')
        opts.tracker.track(container_id)
        try {
            await opts.docker.stopContainer(container_id)
            await opts.docker.removeContainer(container_id)
        } catch (err) {
            log.error({ agent_id, err: errMessage(err) }, 'could not stop a full agent')
            return
        } finally {
            opts.tracker.untrack(container_id)
        }
        opts.status.push({
            agent_id,
            status: 'ERROR',
            container_id: null,
            last_action: `disk limit reached: ${report.used_mb} MB used of ${report.limit_mb} MB`,
            last_action_code: 'disk_limit_reached',
            last_action_at: Date.now(),
        })
    }

    const tick = async (): Promise<void> => {
        // A slow `du` must not stack measures on top of each other.
        if (stopped || running) return
        running = true
        try {
            const agents = await opts.docker.listDiskLimitedAgents()
            if (agents.length === 0) return
            const used = await opts.docker.measureVolumes(
                new Map(agents.map((a) => [a.agent_id, a.volumes]))
            )
            for (const a of agents) {
                const used_bytes = (used.get(a.agent_id) ?? 0) + a.writable_bytes
                const limit_bytes = a.disk_gb * 1024 * MB
                const report: AgentDiskReport = {
                    agent_id: a.agent_id,
                    used_mb: Math.round(used_bytes / MB),
                    limit_mb: a.disk_gb * 1024,
                    level: diskLevel(used_bytes, limit_bytes),
                }
                opts.client.push('agent:disk', report)
                if (report.level === 'full') await stopFull(a.agent_id, a.container_id, report)
            }
        } catch (err) {
            log.warn({ err: errMessage(err) }, 'disk measure failed; skipping this tick')
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

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
