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
        | 'listDiskLimitedAgents'
        | 'measureVolumes'
        | 'stopContainer'
        | 'removeContainer'
        | 'isShared'
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

/**
 * Each agent is measured on its own (its own helper, its own deadline), a few
 * at a time: one with millions of files, or a volume we can't mount, must not
 * leave the others unmeasured (SOKI, #114).
 */
const MEASURE_TIMEOUT_MS = 45_000
const MEASURE_CONCURRENCY = 3
/**
 * A failed measure is NOT an empty disk. On a shared machine, after this many
 * in a row the agent is stopped as if full: an agent that can't be measured
 * can't be held to its ceiling, and its neighbours pay for it.
 */
export const MAX_FAILED_MEASURES = 3

export function startAgentDiskLoop(opts: AgentDiskReporterOptions): AgentDiskHandle {
    const log = opts.logger.child({ component: 'agent-disk' })
    let stopped = false
    let running = false
    /** Consecutive failed measures per agent; gone with the agent. */
    const failures = new Map<number, number>()

    const stopFull = async (
        agent_id: number,
        container_id: string,
        report: AgentDiskReport,
        last_action = `disk limit reached: ${report.used_mb} MB used of ${report.limit_mb} MB`
    ) => {
        log.warn({ ...report, last_action }, 'stopping an agent for its disk')
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
            last_action,
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
            for (const id of failures.keys())
                if (!agents.some((a) => a.agent_id === id)) failures.delete(id)
            const shared = opts.docker.isShared()
            const measureOne = async (a: (typeof agents)[number]) => {
                const limit_mb = a.disk_gb * 1024
                let volume_bytes: number | undefined
                try {
                    const m = await opts.docker.measureVolumes(
                        new Map([[a.agent_id, a.volumes]]),
                        MEASURE_TIMEOUT_MS
                    )
                    volume_bytes = a.volumes.length === 0 ? 0 : m.get(a.agent_id)
                } catch (err) {
                    log.warn({ agent_id: a.agent_id, err: errMessage(err) }, 'disk measure failed')
                }
                if (volume_bytes === undefined) {
                    const n = (failures.get(a.agent_id) ?? 0) + 1
                    failures.set(a.agent_id, n)
                    if (shared && n >= MAX_FAILED_MEASURES) {
                        failures.delete(a.agent_id)
                        await stopFull(
                            a.agent_id,
                            a.container_id,
                            { agent_id: a.agent_id, used_mb: limit_mb, limit_mb, level: 'full' },
                            `disk limit reached: its disk could not be measured ${n} times in a row`
                        )
                    }
                    return
                }
                failures.delete(a.agent_id)
                const used_bytes = volume_bytes + a.writable_bytes
                const report: AgentDiskReport = {
                    agent_id: a.agent_id,
                    used_mb: Math.round(used_bytes / MB),
                    limit_mb,
                    level: diskLevel(used_bytes, limit_mb * MB),
                }
                opts.client.push('agent:disk', report)
                if (report.level === 'full') await stopFull(a.agent_id, a.container_id, report)
            }
            // A few at a time; each one's failure stays its own.
            const queue = [...agents]
            await Promise.all(
                Array.from({ length: Math.min(MEASURE_CONCURRENCY, queue.length) }, async () => {
                    for (let a = queue.shift(); a; a = queue.shift()) await measureOne(a)
                })
            )
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
