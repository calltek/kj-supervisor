/**
 * Push `agent:status` to the control. Fire-and-forget by protocol —
 * the control does not ack these, so a lost event is recovered from
 * the next status push or from the reconciliation that runs at
 * server:hello time.
 */

import type { AgentStatusReport } from '../../protocol'
import type { KJLogger } from '../../logger'

export interface StatusClient {
    push(event: string, payload: unknown): void
}

export class AgentStatusReporter {
    private readonly client: StatusClient
    private readonly logger: KJLogger

    constructor(client: StatusClient, logger: KJLogger) {
        this.client = client
        this.logger = logger.child({ component: 'agent-status' })
    }

    push(report: AgentStatusReport): void {
        this.logger.info(
            {
                agent_id: report.agent_id,
                status: report.status,
                container_id: report.container_id,
                last_action: report.last_action,
            },
            'agent:status push'
        )
        this.client.push('agent:status', report)
    }
}
