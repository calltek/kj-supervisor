/**
 * Handlers for the three "container exists, change its state" commands:
 * agent:stop, agent:pause, agent:resume. They share the same shape —
 *
 *   1. Find the container for the agent_id; fail fast with NO_CONTAINER
 *      if missing (the control thinks something is here that isn't).
 *   2. Ack { ok: true, accepted: true } immediately.
 *   3. In the background: push transient status (STOPPING/PAUSING/
 *      RESUMING) → run the Docker operation → push final status
 *      (STOPPED/PAUSED/RUNNING) on success or ERROR on failure.
 *
 * Stop also removes the container after killing it so the next spawn
 * for that agent_id doesn't trip our ALREADY_RUNNING guard.
 */

import type { KJDocker } from '../docker/client'
import type { KJLogger } from '../logger'
import type {
    AgentPausePayload,
    AgentResumePayload,
    AgentStatusReport,
    AgentStopPayload,
    ControlCommandAck,
    WsErrorPayload,
} from '../protocol'
import type { AgentStatusReporter } from '../reporters/agent-status.reporter'

export interface AgentLifecycleHandlerDeps {
    docker: KJDocker
    status: AgentStatusReporter
    logger: KJLogger
}

export class AgentLifecycleHandler {
    private readonly docker: KJDocker
    private readonly status: AgentStatusReporter
    private readonly logger: KJLogger

    constructor(deps: AgentLifecycleHandlerDeps) {
        this.docker = deps.docker
        this.status = deps.status
        this.logger = deps.logger.child({ component: 'agent-lifecycle' })
    }

    async handleStop(payload: AgentStopPayload): Promise<ControlCommandAck> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
            op: 'stop',
        })
        log.info({ force: payload.force ?? false }, 'agent:stop received')

        const container_id = await this.requireContainer(payload.agent_id, log)
        if (!container_id) {
            return ackError('NO_CONTAINER', `agent ${payload.agent_id} has no container`, false)
        }

        void this.runStop(payload, container_id, log)
        return { ok: true, accepted: true }
    }

    async handlePause(payload: AgentPausePayload): Promise<ControlCommandAck> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
            op: 'pause',
        })
        log.info('agent:pause received')

        const container_id = await this.requireContainer(payload.agent_id, log)
        if (!container_id) {
            return ackError('NO_CONTAINER', `agent ${payload.agent_id} has no container`, false)
        }

        void this.runPause(payload, container_id, log)
        return { ok: true, accepted: true }
    }

    async handleResume(payload: AgentResumePayload): Promise<ControlCommandAck> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
            op: 'resume',
        })
        log.info('agent:resume received')

        const container_id = await this.requireContainer(payload.agent_id, log)
        if (!container_id) {
            return ackError('NO_CONTAINER', `agent ${payload.agent_id} has no container`, false)
        }

        void this.runResume(payload, container_id, log)
        return { ok: true, accepted: true }
    }

    // ──────────────────────────────────────────────────────────────────
    // Background workers
    // ──────────────────────────────────────────────────────────────────

    private async runStop(
        payload: AgentStopPayload,
        container_id: string,
        log: KJLogger
    ): Promise<void> {
        this.push({
            agent_id: payload.agent_id,
            status: 'STOPPING',
            container_id,
            last_action: payload.force ? 'killing (SIGKILL)' : 'stopping (SIGTERM, 10s grace)',
            last_action_at: Date.now(),
        })

        try {
            await this.docker.stopContainer(container_id, { force: payload.force })
            // Remove the container so the next spawn for this agent_id doesn't
            // collide with our ALREADY_RUNNING guard.
            await this.docker.removeContainer(container_id)
        } catch (err) {
            log.error({ err: errMessage(err) }, 'stop failed')
            this.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id,
                last_action: `stop failed: ${errMessage(err)}`,
                last_action_at: Date.now(),
            })
            return
        }

        log.info('agent stopped and removed')
        this.push({
            agent_id: payload.agent_id,
            status: 'STOPPED',
            container_id: null,
            last_action_at: Date.now(),
        })
    }

    private async runPause(
        payload: AgentPausePayload,
        container_id: string,
        log: KJLogger
    ): Promise<void> {
        this.push({
            agent_id: payload.agent_id,
            status: 'PAUSING',
            container_id,
            last_action_at: Date.now(),
        })

        try {
            await this.docker.pauseContainer(container_id)
        } catch (err) {
            log.error({ err: errMessage(err) }, 'pause failed')
            this.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id,
                last_action: `pause failed: ${errMessage(err)}`,
                last_action_at: Date.now(),
            })
            return
        }

        log.info('agent paused')
        this.push({
            agent_id: payload.agent_id,
            status: 'PAUSED',
            container_id,
            last_action_at: Date.now(),
        })
    }

    private async runResume(
        payload: AgentResumePayload,
        container_id: string,
        log: KJLogger
    ): Promise<void> {
        this.push({
            agent_id: payload.agent_id,
            status: 'RESUMING',
            container_id,
            last_action_at: Date.now(),
        })

        try {
            await this.docker.unpauseContainer(container_id)
        } catch (err) {
            log.error({ err: errMessage(err) }, 'resume failed')
            this.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id,
                last_action: `resume failed: ${errMessage(err)}`,
                last_action_at: Date.now(),
            })
            return
        }

        log.info('agent resumed')
        this.push({
            agent_id: payload.agent_id,
            status: 'RUNNING',
            container_id,
            last_action_at: Date.now(),
        })
    }

    // ──────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────

    /**
     * Look up the container for agent_id. Returns null and logs if the
     * list call itself fails (treated the same as not-found from the
     * caller's perspective: we can't proceed, but it isn't a crash).
     */
    private async requireContainer(agent_id: number, log: KJLogger): Promise<string | null> {
        try {
            const containers = await this.docker.listKjContainers()
            const match = containers.find((c) => c.agent_id === agent_id)
            if (!match) {
                log.warn('no container found for agent')
                return null
            }
            return match.container_id
        } catch (err) {
            log.error({ err: errMessage(err) }, 'failed to list containers')
            return null
        }
    }

    private push(report: AgentStatusReport): void {
        this.status.push(report)
    }
}

function ackError(code: string, message: string, retryable: boolean): ControlCommandAck {
    const error: WsErrorPayload = {
        code: code as WsErrorPayload['code'],
        message,
        retryable,
    }
    return { ok: false, error }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
