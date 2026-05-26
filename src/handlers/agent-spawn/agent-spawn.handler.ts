/**
 * Handler for `agent:spawn`. Pulls the image, runs a container with
 * the requested env/resources, and pushes agent:status updates as the
 * lifecycle progresses (SPAWNING → RUNNING, or ERROR on failure).
 *
 * The ack returns synchronously *before* the Docker work runs:
 *   - ALREADY_RUNNING if a kj-agent container for this id already exists,
 *   - { ok: true, accepted: true } otherwise.
 * Real outcome (RUNNING / ERROR) is reported asynchronously via push.
 */

import type { AgentSpawnPayload, ControlCommandAck, WsErrorPayload } from '../../protocol'
import {
    KJ_LABEL,
    KJ_LABEL_AGENT_ID,
    type KJDocker,
    type PullProgressEvent,
} from '../../docker/client/client'
import type { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'
import { StatusHeartbeat } from '../../reporters/status-heartbeat/status-heartbeat'
import type { AgentStreamManager } from '../../agent-stream/stream-manager'
import type { KJLogger } from '../../logger'

export interface AgentSpawnHandlerDeps {
    docker: KJDocker
    status: AgentStatusReporter
    streams: AgentStreamManager
    logger: KJLogger
}

export class AgentSpawnHandler {
    private readonly docker: KJDocker
    private readonly status: AgentStatusReporter
    private readonly streams: AgentStreamManager
    private readonly logger: KJLogger

    constructor(deps: AgentSpawnHandlerDeps) {
        this.docker = deps.docker
        this.status = deps.status
        this.streams = deps.streams
        this.logger = deps.logger.child({ component: 'agent-spawn' })
    }

    /**
     * Entry point bound to the WS event. Returns the ack synchronously
     * and runs the actual spawn in the background — the protocol
     * expects ack = "received", not ack = "done".
     */
    async handle(payload: AgentSpawnPayload): Promise<ControlCommandAck> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
        })
        log.info({ image_tag: payload.image_tag }, 'agent:spawn received')

        // 1. Guard against duplicates. The control sees the same agent_id as
        //    RUNNING already; this is its own race or a stale retry.
        const existing = await this.findExistingContainer(payload.agent_id).catch((err) => {
            log.error({ err: errMessage(err) }, 'failed to list containers; spawn aborted')
            return undefined
        })
        if (existing) {
            log.warn({ container_id: existing }, 'agent already has a container — rejecting')
            return ackError(
                'ALREADY_RUNNING',
                `agent ${payload.agent_id} already has a container`,
                false,
                {
                    container_id: existing,
                }
            )
        }

        // 2. Kick off the actual spawn in background so the ack can return now.
        void this.spawn(payload).catch((err) => {
            log.error({ err: errMessage(err) }, 'unhandled error inside spawn')
            this.status.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id: null,
                last_action: errMessage(err),
                last_action_at: Date.now(),
            })
        })

        return { ok: true, accepted: true }
    }

    /** Runs after the ack. Reports progress via agent:status pushes. */
    private async spawn(payload: AgentSpawnPayload): Promise<void> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
        })

        // Heartbeat keeps last_action_at fresh while pulling. The pull
        // callback rewrites last_action so the operator sees real progress
        // rather than a frozen "pulling image" string.
        const pullHeartbeat = new StatusHeartbeat({
            reporter: this.status,
            agent_id: payload.agent_id,
            status: 'SPAWNING',
            initial_last_action: `pulling ${payload.image_tag}`,
        }).start()

        // Optional credentials sent by the control for private images
        // (e.g. ghcr.io/calltek/kj-agent-base). Absent for public ones.
        // Treated as ephemeral: used here for this pull and forgotten.
        const pullAuth = payload.registry_credentials
            ? {
                  username: payload.registry_credentials.username,
                  password: payload.registry_credentials.password,
                  serveraddress: payload.registry_credentials.registry,
              }
            : undefined

        // Skip the pull when the image is already cached locally.
        // Saves a round-trip in steady state, and is mandatory for
        // dev workflows where the operator built the image directly
        // (e.g. `docker build -t ...:dev-local .`) and there is no
        // matching tag in the remote registry.
        const cached = await this.docker.imageExistsLocally(payload.image_tag)
        if (cached) {
            log.info({ image_tag: payload.image_tag }, 'image cached locally; skipping pull')
            pullHeartbeat.update(`using cached ${payload.image_tag}`)
        } else {
            try {
                await this.docker.pullImage(
                    payload.image_tag,
                    (event) => {
                        const summary = summarizePullEvent(event, payload.image_tag)
                        if (summary) pullHeartbeat.update(summary)
                    },
                    pullAuth
                )
            } catch (err) {
                pullHeartbeat.stop()
                log.error({ err: errMessage(err) }, 'image pull failed')
                this.status.push({
                    agent_id: payload.agent_id,
                    status: 'ERROR',
                    container_id: null,
                    last_action: `image pull failed: ${errMessage(err)}`,
                    last_action_at: Date.now(),
                })
                return
            }
        }
        pullHeartbeat.stop()

        // Quick beat so the panel knows we've moved past pull.
        this.status.push({
            agent_id: payload.agent_id,
            status: 'SPAWNING',
            last_action: 'starting container',
            last_action_at: Date.now(),
        })

        let container_id: string
        try {
            container_id = await this.docker.runContainer({
                image_tag: payload.image_tag,
                name: `kj-agent-${payload.agent_id}`,
                env: this.buildContainerEnv(payload),
                // Milestone 2: alpine sleep infinity-style smoke. Real agent
                // images will have their own ENTRYPOINT and we drop Cmd.
                cmd: payload.image_tag.startsWith('alpine') ? ['sleep', 'infinity'] : undefined,
                labels: {
                    [KJ_LABEL]: 'true',
                    [KJ_LABEL_AGENT_ID]: String(payload.agent_id),
                },
                resources: payload.resources,
            })
        } catch (err) {
            log.error({ err: errMessage(err) }, 'docker run failed')
            this.status.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id: null,
                last_action: `docker run failed: ${errMessage(err)}`,
                last_action_at: Date.now(),
            })
            return
        }

        // Attach to stdio so we start forwarding the agent's stream-json
        // output and can later deliver `agent:input`. Failure here is
        // best-effort logged: the container is alive, the operator can
        // still see lifecycle status — they just won't see the agent's
        // conversation until a reattach (TODO: trigger on the next docker
        // event).
        await this.streams.attach({
            agent_id: payload.agent_id,
            container_id,
            session_id: payload.session_id,
        })

        log.info({ container_id }, 'agent container running')
        this.status.push({
            agent_id: payload.agent_id,
            status: 'RUNNING',
            container_id,
            last_action_at: Date.now(),
        })
    }

    /**
     * Merge the spawn payload's `env` with the dedicated session and
     * OAuth fields, keeping the secret out of `payload.env` so the
     * control never has to embed it in two places. Order matters: the
     * dedicated fields win over anything the control might have
     * accidentally duplicated.
     */
    private buildContainerEnv(payload: AgentSpawnPayload): Record<string, string> {
        return {
            ...payload.env,
            KJ_SESSION_ID: payload.session_id,
            CLAUDE_CODE_OAUTH_TOKEN: payload.oauth_token,
        }
    }

    private async findExistingContainer(agent_id: number): Promise<string | null> {
        const containers = await this.docker.listKjContainers()
        const match = containers.find((c) => c.agent_id === agent_id)
        return match ? match.container_id : null
    }
}

function ackError(
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>
): ControlCommandAck {
    const error: WsErrorPayload = {
        code: code as WsErrorPayload['code'],
        message,
        retryable,
        details,
    }
    return { ok: false, error }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/**
 * Compact one-line description of a single pull progress event,
 * suitable for `agent:status.last_action`. Returns null for events
 * we don't care to surface (e.g. "Already exists" on cached layers).
 */
function summarizePullEvent(event: PullProgressEvent, image_tag: string): string | null {
    if (!event.status) return null

    // "Downloading" + progress string is the most useful one.
    if (event.status === 'Downloading' && event.id) {
        const detail = event.progressDetail
        if (detail?.total) {
            const pct = Math.round(((detail.current ?? 0) / detail.total) * 100)
            return `pulling ${image_tag} — layer ${event.id} ${pct}%`
        }
        return `pulling ${image_tag} — layer ${event.id} downloading`
    }
    if (event.status === 'Extracting' && event.id) {
        return `pulling ${image_tag} — layer ${event.id} extracting`
    }
    if (event.status.startsWith('Pulling from')) {
        return `pulling ${image_tag}`
    }
    if (event.status === 'Pull complete' || event.status === 'Download complete') {
        return null // too chatty
    }
    return `pulling ${image_tag} — ${event.status}`
}
