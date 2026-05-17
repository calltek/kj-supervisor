/**
 * Periodic agent:status push while a long-running operation
 * (image pull, container stop with grace) is in flight.
 *
 * Why: operations whose duration depends on network or grace
 * periods can't be bounded by a fixed timeout — the supervisor
 * sits in a different VPS than the next one, and Frankfurt is
 * not São Paulo. Instead of guessing, we report progress every
 * N seconds so the control can tell "still working" from "stuck"
 * by looking at last_action_at, and the operator sees a live
 * description of what's happening.
 *
 * Lifecycle:
 *   const hb = new StatusHeartbeat({ ... }).start()
 *   ...do work, occasionally calling hb.update('new last_action')...
 *   hb.stop()  // before pushing the final RUNNING/STOPPED/etc.
 */

import type { AgentStatusReport } from '../../protocol'
import type { AgentStatusReporter } from '../agent-status/agent-status.reporter'

export interface StatusHeartbeatOptions {
    reporter: AgentStatusReporter
    agent_id: number
    container_id?: string | null
    status: AgentStatusReport['status']
    initial_last_action: string
    /** Push cadence in ms. Default 5_000. */
    interval_ms?: number
}

export class StatusHeartbeat {
    private readonly reporter: AgentStatusReporter
    private readonly agent_id: number
    private readonly container_id: string | null | undefined
    private readonly status: AgentStatusReport['status']
    private readonly interval_ms: number

    private last_action: string
    private timer: ReturnType<typeof setInterval> | null = null

    constructor(opts: StatusHeartbeatOptions) {
        this.reporter = opts.reporter
        this.agent_id = opts.agent_id
        this.container_id = opts.container_id
        this.status = opts.status
        this.last_action = opts.initial_last_action
        this.interval_ms = opts.interval_ms ?? 5_000
    }

    /** Push an initial heartbeat and start the periodic loop. */
    start(): this {
        if (this.timer) return this
        this.push()
        this.timer = setInterval(() => this.push(), this.interval_ms)
        return this
    }

    /**
     * Change the message shown in `last_action`. Pushes immediately
     * (don't wait for the next tick — granular feedback is the point).
     */
    update(last_action: string): void {
        this.last_action = last_action
        this.push()
    }

    /** Cancel the periodic push. Idempotent. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    private push(): void {
        const report: AgentStatusReport = {
            agent_id: this.agent_id,
            status: this.status,
            container_id: this.container_id,
            last_action: this.last_action,
            last_action_at: Date.now(),
        }
        this.reporter.push(report)
    }
}
