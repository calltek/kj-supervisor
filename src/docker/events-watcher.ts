/**
 * Listens to the docker daemon events stream for kj-agent containers
 * and translates external state changes into agent:status pushes.
 *
 * Why: the supervisor doesn't have a monopoly on the VPS. Someone with
 * shell access can `docker stop` / `docker rm` / `docker pause` our
 * containers. Without this watcher the control would keep believing
 * a dead container is RUNNING until the next reconciliation (~minutes).
 *
 * Distinguishing ours from external:
 *   - Every supervisor-driven mutation (stop/pause/resume/remove) goes
 *     through OperationTracker.track(container_id) just before the
 *     docker call and untrack() right after.
 *   - When an event arrives whose container_id IS tracked, the
 *     corresponding handler is already pushing the final status; the
 *     watcher stays silent.
 *   - When it ISN'T tracked, the watcher pushes a status reflecting
 *     the new state so the control catches the drift.
 */

import { KJ_LABEL_AGENT_ID, type DockerEvent, type KJDocker } from './client'
import type { OperationTracker } from './operation-tracker'
import type { KJLogger } from '../logger'
import type { AgentStatusReport } from '../protocol'
import type { AgentStatusReporter } from '../reporters/agent-status.reporter'

export interface KJDockerEventsWatcherDeps {
    docker: KJDocker
    tracker: OperationTracker
    status: AgentStatusReporter
    logger: KJLogger
}

const RECONNECT_DELAY_MS = 2_000

export class KJDockerEventsWatcher {
    private readonly docker: KJDocker
    private readonly tracker: OperationTracker
    private readonly status: AgentStatusReporter
    private readonly logger: KJLogger

    private stream: NodeJS.ReadableStream | null = null
    private stopped = false
    private reconnect_timer: ReturnType<typeof setTimeout> | null = null

    constructor(deps: KJDockerEventsWatcherDeps) {
        this.docker = deps.docker
        this.tracker = deps.tracker
        this.status = deps.status
        this.logger = deps.logger.child({ component: 'docker-events' })
    }

    /** Start listening. Idempotent. */
    async start(): Promise<void> {
        if (this.stream) return
        this.stopped = false
        await this.connect()
    }

    stop(): void {
        this.stopped = true
        if (this.reconnect_timer) {
            clearTimeout(this.reconnect_timer)
            this.reconnect_timer = null
        }
        if (this.stream) {
            // dockerode streams are paused-mode Node streams; destroy() cancels.
            const s = this.stream as NodeJS.ReadableStream & { destroy?: () => void }
            s.destroy?.()
            this.stream = null
        }
    }

    private async connect(): Promise<void> {
        if (this.stopped) return
        try {
            const stream = await this.docker.getEvents()
            this.stream = stream
            this.logger.info('docker events stream connected')

            let buffer = ''
            stream.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf8')
                let nl = buffer.indexOf('\n')
                while (nl !== -1) {
                    const line = buffer.slice(0, nl).trim()
                    buffer = buffer.slice(nl + 1)
                    if (line) this.handleLine(line)
                    nl = buffer.indexOf('\n')
                }
            })
            stream.on('error', (err) => {
                this.logger.warn({ err: errMessage(err) }, 'events stream error')
                this.scheduleReconnect()
            })
            stream.on('end', () => {
                this.logger.warn('events stream ended')
                this.scheduleReconnect()
            })
            stream.on('close', () => {
                this.logger.warn('events stream closed')
                this.scheduleReconnect()
            })
        } catch (err) {
            this.logger.warn(
                { err: errMessage(err) },
                'failed to subscribe to docker events; will retry'
            )
            this.scheduleReconnect()
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnect_timer) return
        this.stream = null
        this.reconnect_timer = setTimeout(() => {
            this.reconnect_timer = null
            void this.connect()
        }, RECONNECT_DELAY_MS)
    }

    private handleLine(line: string): void {
        let event: DockerEvent
        try {
            event = JSON.parse(line) as DockerEvent
        } catch (err) {
            this.logger.warn({ line, err: errMessage(err) }, 'failed to parse docker event')
            return
        }

        if (event.Type !== 'container') return

        const container_id = event.Actor?.ID
        const agent_id_raw = event.Actor?.Attributes?.[KJ_LABEL_AGENT_ID]
        if (!container_id || !agent_id_raw) return

        const agent_id = Number.parseInt(agent_id_raw, 10)
        if (!Number.isFinite(agent_id)) return

        if (this.tracker.isTracked(container_id)) {
            this.logger.debug(
                { action: event.Action, container_id, agent_id },
                'ignoring our own operation'
            )
            return
        }

        const report = this.translate(event, agent_id, container_id)
        if (!report) return

        this.logger.warn(
            { action: event.Action, container_id, agent_id, status: report.status },
            'external docker event — reporting drift'
        )
        this.status.push(report)
    }

    /**
     * Map a Docker action to an agent:status. Returns null for actions
     * we don't reflect (create, attach, exec_start, etc.).
     */
    private translate(
        event: DockerEvent,
        agent_id: number,
        container_id: string
    ): AgentStatusReport | null {
        switch (event.Action) {
            case 'die':
            case 'stop':
            case 'kill':
                return {
                    agent_id,
                    status: 'STOPPED',
                    container_id,
                    last_action: `external ${event.Action}`,
                    last_action_at: Date.now(),
                }
            case 'destroy':
                return {
                    agent_id,
                    status: 'STOPPED',
                    container_id: null,
                    last_action: 'container removed externally',
                    last_action_at: Date.now(),
                }
            case 'pause':
                return {
                    agent_id,
                    status: 'PAUSED',
                    container_id,
                    last_action: 'paused externally',
                    last_action_at: Date.now(),
                }
            case 'unpause':
                return {
                    agent_id,
                    status: 'RUNNING',
                    container_id,
                    last_action: 'unpaused externally',
                    last_action_at: Date.now(),
                }
            default:
                return null
        }
    }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
