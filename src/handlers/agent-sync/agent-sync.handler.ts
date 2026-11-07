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
import type { RunningListener } from '../../reporters/agent-status/agent-status.reporter'
import type { NetPolicyService } from '../../docker/client/net-policy-service'

export interface AgentSyncHandlerDeps {
    streams: AgentStreamManager
    logger: KJLogger
    /**
     * Told about every container re-attached here. These never go through a
     * RUNNING status push (they were already running), so without this an
     * agent that predates the image report would wait for its next recreate.
     */
    running?: RunningListener
    /** What the agent may reach (net-policy-service.ts). Optional for tests. */
    netPolicy?: Pick<NetPolicyService, 'enforce'>
    /** Who a container belongs to, by its label. Optional for tests. */
    docker?: { agentIdOfContainer(container_id: string): Promise<number | null> }
}

export class AgentSyncHandler {
    private readonly streams: AgentStreamManager
    private readonly logger: KJLogger
    private readonly running?: RunningListener
    private readonly netPolicy?: AgentSyncHandlerDeps['netPolicy']

    private readonly docker?: AgentSyncHandlerDeps['docker']

    constructor(deps: AgentSyncHandlerDeps) {
        this.docker = deps.docker
        this.netPolicy = deps.netPolicy
        this.streams = deps.streams
        this.running = deps.running
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
        // The container must be THIS agent's: attached to another, agent X's
        // stream would carry agent Y's output and Y's tool calls would go out
        // stamped as X — on a shared machine, another tenant's. The label is
        // ours (agents can't create containers or labels), the id is the
        // control's: if they disagree, nothing is attached.
        if (this.docker) {
            const owner = await this.docker.agentIdOfContainer(entry.container_id)
            if (owner !== entry.agent_id)
                throw new Error(
                    `container ${entry.container_id} belongs to agent ${owner ?? 'none'}, not ${entry.agent_id}`
                )
        }
        await this.streams.attach({
            agent_id: entry.agent_id,
            container_id: entry.container_id,
            session_id: entry.session_id,
            conversations: entry.conversations,
        })
        this.running?.report(entry.agent_id, entry.container_id, { force: true })
        // The rules survived this supervisor's restart (they live in the
        // agent's namespace), but this one may write a newer version, and it
        // needs the policy in memory for the next browser.
        await this.netPolicy?.enforce(
            entry.agent_id,
            entry.container_id,
            (entry as { network_policy?: unknown }).network_policy
        )
    }
}
