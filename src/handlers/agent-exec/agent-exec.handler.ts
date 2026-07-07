/**
 * Handler for `agent:exec`. Runs a one-shot command inside the agent's
 * container and acks synchronously with the exit code + (truncated) output.
 * Used by SCRIPT cronjobs. Resolves the container by agent_id from the live
 * KJ container list; if the agent has no container, acks AGENT_NOT_RUNNING.
 */

import type { KJDocker } from '../../docker/client/client'
import type { KJLogger } from '../../logger'
import { type AgentExecAck, type AgentExecPayload, WS_ERROR_CODES } from '../../protocol'

// Output handed back to the control is truncated — the cron service truncates
// again before storing/feeding to the agent, but keep the wire payload bounded.
const MAX_OUTPUT_BYTES = 32 * 1024

export interface AgentExecHandlerDeps {
    docker: KJDocker
    logger: KJLogger
}

export class AgentExecHandler {
    private readonly docker: KJDocker
    private readonly logger: KJLogger

    constructor(deps: AgentExecHandlerDeps) {
        this.docker = deps.docker
        this.logger = deps.logger.child({ component: 'agent-exec' })
    }

    async handle(payload: AgentExecPayload): Promise<AgentExecAck> {
        const container_id = await this.resolveContainer(payload.agent_id)
        if (!container_id) {
            return {
                ok: false,
                request_id: payload.request_id,
                error: {
                    code: WS_ERROR_CODES.AGENT_NOT_RUNNING,
                    message: `agent ${payload.agent_id} has no running container`,
                    retryable: true,
                },
            }
        }

        try {
            const result = await this.docker.exec({
                container_id,
                command: payload.command,
                timeout_ms: payload.timeout_ms ?? 60_000,
                maxOutputBytes: MAX_OUTPUT_BYTES,
                // Per-exec env (KJ-38): a SCRIPT cron's injected credentials.
                env: payload.env,
            })
            this.logger.info(
                {
                    request_id: payload.request_id,
                    agent_id: payload.agent_id,
                    exit_code: result.exit_code,
                    timed_out: result.timedOut,
                },
                'agent:exec done'
            )
            return {
                ok: true,
                request_id: payload.request_id,
                exit_code: result.exit_code,
                output: result.output,
                truncated: result.truncated,
                // Report the timeout as its own reason (KJ-131) instead of
                // masking it as a truncated success — the control marks the run
                // TIMEOUT off this.
                timed_out: result.timedOut,
            }
        } catch (err) {
            return {
                ok: false,
                request_id: payload.request_id,
                error: {
                    code: WS_ERROR_CODES.INTERNAL_ERROR,
                    message: err instanceof Error ? err.message : String(err),
                    retryable: true,
                },
            }
        }
    }

    private async resolveContainer(agent_id: number): Promise<string | null> {
        const containers = await this.docker.listKjContainers().catch(() => [])
        const match = containers.find((c) => c.agent_id === agent_id)
        return match ? match.container_id : null
    }
}
