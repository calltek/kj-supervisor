/**
 * Handler for `agent:sync`. Called by the control right after
 * `server:hello` reconcile for every container the supervisor
 * reported alive. Each entry carries the bits the supervisor needs
 * to re-open the stdio attach duplex it lost on restart: the
 * agent_id + container_id (so we know what to attach), the
 * session_id (so the stream parser stamps every output event with
 * the right Claude Code session) and the oauth_token (unused by
 * the attach itself, but kept in the protocol so a future respawn
 * path can re-arm the container without another round trip).
 *
 * Acks once all attach attempts have settled. Individual failures
 * are warned and dropped — they shouldn't fail the whole batch
 * because the operator usually cares about "most agents are back"
 * more than "this one specific agent is back".
 */

import type { KJLogger } from '../../logger'
import type { AgentSyncEntry, AgentSyncPayload, ControlCommandAck } from '../../protocol'
import type { AgentStreamManager } from '../../agent-stream/stream-manager'

export interface AgentSyncHandlerDeps {
    streams: AgentStreamManager
    logger: KJLogger
}

export class AgentSyncHandler {
    private readonly streams: AgentStreamManager
    private readonly logger: KJLogger

    constructor(deps: AgentSyncHandlerDeps) {
        this.streams = deps.streams
        this.logger = deps.logger.child({ component: 'agent-sync' })
    }

    async handle(payload: AgentSyncPayload): Promise<ControlCommandAck> {
        const entries = Array.isArray(payload.entries) ? payload.entries : []

        if (entries.length === 0) {
            this.logger.info({ request_id: payload.request_id }, 'agent:sync with empty entries')
            return { ok: true, accepted: true }
        }

        this.logger.info(
            { request_id: payload.request_id, count: entries.length },
            'agent:sync received — re-attaching'
        )

        // Drive attaches in parallel — stream-manager.attach is idempotent
        // and isolated per agent, so there's no ordering concern. We
        // settle them all and log failures individually before acking.
        const results = await Promise.allSettled(entries.map((e) => this.attachOne(e)))

        let failures = 0
        for (let i = 0; i < results.length; i++) {
            const r = results[i]
            const entry = entries[i]
            if (!r || !entry || r.status !== 'rejected') continue
            failures++
            this.logger.warn(
                {
                    agent_id: entry.agent_id,
                    err: r.reason instanceof Error ? r.reason.message : String(r.reason),
                },
                'agent:sync attach failed'
            )
        }

        this.logger.info(
            {
                request_id: payload.request_id,
                attached: entries.length - failures,
                failed: failures,
            },
            'agent:sync done'
        )

        return { ok: true, accepted: true }
    }

    private async attachOne(entry: AgentSyncEntry): Promise<void> {
        await this.streams.attach({
            agent_id: entry.agent_id,
            container_id: entry.container_id,
            session_id: entry.session_id,
        })
    }
}
