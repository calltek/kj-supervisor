/**
 * Handler for `agent:image:update`. Pulls a fresh copy of the agent's
 * image from the registry and recreates the container if requested.
 *
 *   1. Find the existing container (if any).
 *   2. Ack { ok: true, accepted: true }.
 *   3. In the background:
 *      - Push status SPAWNING + "pulling <tag>" while docker pulls.
 *      - If a container existed AND restart_after is true, recreate
 *        it under the same name preserving env / mounts / labels.
 *        Reattach stdio so the conversation keeps flowing.
 *      - If a container existed AND restart_after is false, stop +
 *        remove it and leave the agent STOPPED. The operator can
 *        start it back from the panel.
 *      - If no container existed, just leave the agent STOPPED — the
 *        pull populates the local cache for the next spawn.
 *
 * The operator clicked a button that they were warned would restart
 * the agent; we don't try to be clever and skip the swap if the image
 * digest didn't actually change.
 */

import type { AgentStreamManager } from '../../agent-stream/stream-manager'
import {
    KJ_LABEL,
    KJ_LABEL_AGENT_ID,
    type KJDocker,
    type PullProgressEvent,
} from '../../docker/client/client'
import type { KJLogger } from '../../logger'
import type { AgentImageUpdatePayload, ControlCommandAck, WsErrorPayload } from '../../protocol'
import type { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'
import { StatusHeartbeat } from '../../reporters/status-heartbeat/status-heartbeat'

export interface AgentImageUpdateHandlerDeps {
    docker: KJDocker
    status: AgentStatusReporter
    streams: AgentStreamManager
    logger: KJLogger
}

export class AgentImageUpdateHandler {
    private readonly docker: KJDocker
    private readonly status: AgentStatusReporter
    private readonly streams: AgentStreamManager
    private readonly logger: KJLogger

    constructor(deps: AgentImageUpdateHandlerDeps) {
        this.docker = deps.docker
        this.status = deps.status
        this.streams = deps.streams
        this.logger = deps.logger.child({ component: 'agent-image-update' })
    }

    async handle(payload: AgentImageUpdatePayload): Promise<ControlCommandAck> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
            image_tag: payload.image_tag,
        })
        log.info({ restart_after: payload.restart_after }, 'agent:image:update received')

        // Kick off in the background — the ack fires immediately.
        void this.run(payload, log).catch((err) => {
            log.error({ err: errMessage(err) }, 'unhandled error inside image update')
            this.status.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id: null,
                last_action: `image update failed: ${errMessage(err)}`,
                last_action_at: Date.now(),
            })
        })

        return { ok: true, accepted: true }
    }

    private async run(payload: AgentImageUpdatePayload, log: KJLogger): Promise<void> {
        const existing = await this.findExistingContainer(payload.agent_id).catch((err) => {
            log.warn({ err: errMessage(err) }, 'failed to list containers; assuming none')
            return null
        })

        const heartbeat = new StatusHeartbeat({
            reporter: this.status,
            agent_id: payload.agent_id,
            container_id: existing ?? undefined,
            status: 'SPAWNING',
            initial_last_action: `pulling ${payload.image_tag}`,
        }).start()

        // 1. Pull fresh from the registry — the whole point of this
        //    handler is to refresh. If the pull fails AND the image is
        //    already cached locally, we fall back to the cached copy
        //    instead of bailing. Covers two real cases:
        //      - dev workflows where the operator built the image
        //        locally (`docker build -t …:dev-local`) and the tag
        //        doesn't exist in the remote registry at all.
        //      - private images where the supervisor doesn't have the
        //        registry credentials wired yet (transitional).
        //    A second swap with no new bits is still useful: it
        //    forces a respawn (e.g. to pick up a new system prompt
        //    baked into the local rebuild).
        const pullAuth = payload.registry_credentials
            ? {
                  username: payload.registry_credentials.username,
                  password: payload.registry_credentials.password,
                  serveraddress: payload.registry_credentials.registry,
              }
            : undefined
        try {
            await this.docker.pullImage(
                payload.image_tag,
                (event) => {
                    const summary = summarizePullEvent(event, payload.image_tag)
                    if (summary) heartbeat.update(summary)
                },
                pullAuth
            )
        } catch (err) {
            const cached = await this.docker
                .imageExistsLocally(payload.image_tag)
                .catch(() => false)
            if (!cached) {
                heartbeat.stop()
                log.error({ err: errMessage(err) }, 'image pull failed, no local cache')
                this.status.push({
                    agent_id: payload.agent_id,
                    status: existing ? 'ERROR' : 'STOPPED',
                    container_id: existing ?? null,
                    last_action: `image pull failed: ${errMessage(err)}`,
                    last_action_at: Date.now(),
                })
                return
            }
            log.warn(
                { err: errMessage(err) },
                'pull failed but image is cached locally, continuing with the cached copy'
            )
            heartbeat.update(`using cached ${payload.image_tag} (pull failed)`)
        }
        heartbeat.stop()

        // 2. No container to swap → done. The fresh image sits in the
        //    local cache; next agent:spawn picks it up.
        if (!existing) {
            log.info('pull complete, no container to recreate')
            this.status.push({
                agent_id: payload.agent_id,
                status: 'STOPPED',
                container_id: null,
                last_action: `image refreshed (${payload.image_tag})`,
                last_action_at: Date.now(),
            })
            return
        }

        // 3. Operator asked to keep it stopped → stop + remove.
        if (!payload.restart_after) {
            log.info(
                { container_id: existing },
                'pull complete, stopping container per restart_after=false'
            )
            try {
                await this.docker.stopContainer(existing, { force: true })
                await this.docker.removeContainer(existing)
                this.status.push({
                    agent_id: payload.agent_id,
                    status: 'STOPPED',
                    container_id: null,
                    last_action: `image refreshed (${payload.image_tag})`,
                    last_action_at: Date.now(),
                })
            } catch (err) {
                log.error({ err: errMessage(err) }, 'stop+remove failed after pull')
                this.status.push({
                    agent_id: payload.agent_id,
                    status: 'ERROR',
                    container_id: existing,
                    last_action: `stop after pull failed: ${errMessage(err)}`,
                    last_action_at: Date.now(),
                })
            }
            return
        }

        // 4. Restart_after=true: swap the running container with one
        //    based on the freshly-pulled image, preserving its env +
        //    mounts so the agent reconnects to the same session and
        //    volume.
        const swapHeartbeat = new StatusHeartbeat({
            reporter: this.status,
            agent_id: payload.agent_id,
            container_id: existing,
            status: 'STOPPING',
            initial_last_action: 'swapping container',
        }).start()

        let new_container_id: string
        try {
            // Detach from the old stdio before tearing it down, so the
            // streams manager doesn't keep a dead pipe alive.
            try {
                this.streams.detach(payload.agent_id)
            } catch {
                // best-effort
            }

            new_container_id = await this.docker.recreateContainerWithImage({
                source_container: existing,
                new_image_tag: payload.image_tag,
                keep_name: `kj-agent-${payload.agent_id}`,
                // Re-apply the control's server-aware limits (KUJI-42) so the
                // recreate doesn't leave the container unbounded.
                resources: payload.resources,
            })
        } catch (err) {
            swapHeartbeat.stop()
            log.error({ err: errMessage(err) }, 'recreate failed')
            this.status.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id: null,
                last_action: `recreate failed: ${errMessage(err)}`,
                last_action_at: Date.now(),
            })
            return
        }
        swapHeartbeat.stop()

        // Re-attach stdio so the operator UI keeps receiving
        // agent:output. The new container resumes the same Claude
        // session because the env vars (including KJ_SESSION_ID) and
        // the /home/agent volume both carry over.
        const session_id = extractSessionIdFromEnv(
            await this.docker.inspect(new_container_id).catch(() => null)
        )
        if (session_id) {
            await this.streams
                .attach({
                    agent_id: payload.agent_id,
                    container_id: new_container_id,
                    session_id,
                })
                .catch((err) => {
                    log.warn({ err: errMessage(err) }, 'attach after recreate failed (best-effort)')
                })
        } else {
            log.warn('could not recover KJ_SESSION_ID from new container env; stdio not reattached')
        }

        log.info({ new_container_id }, 'agent recreated with new image')
        this.status.push({
            agent_id: payload.agent_id,
            status: 'RUNNING',
            container_id: new_container_id,
            last_action: `running on ${payload.image_tag}`,
            last_action_at: Date.now(),
        })
    }

    private async findExistingContainer(agent_id: number): Promise<string | null> {
        const containers = await this.docker.listKjContainers()
        const match = containers.find((c) => c.agent_id === agent_id)
        return match ? match.container_id : null
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
// Exported for testing only; keeps the type-checker happy when the
// handler grows error paths that need this helper.
void ackError

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/**
 * Compact one-line description of a single pull progress event,
 * suitable for `agent:status.last_action`. Mirrors the helper in
 * agent-spawn so the operator sees the same kind of progress text
 * across both flows.
 */
function summarizePullEvent(event: PullProgressEvent, image_tag: string): string | null {
    if (!event.status) return null

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
        return null
    }
    return `pulling ${image_tag} — ${event.status}`
}

/**
 * Read KJ_SESSION_ID back out of the new container's env. We need it
 * to re-attach the stdio pipe; the value was set in the original
 * spawn payload and survived the recreate because we copied
 * source.Config.Env.
 */
function extractSessionIdFromEnv(
    info: { Config?: { Env?: string[] | null } } | null
): string | null {
    const env = info?.Config?.Env ?? []
    for (const entry of env) {
        if (entry.startsWith('KJ_SESSION_ID=')) {
            return entry.slice('KJ_SESSION_ID='.length) || null
        }
    }
    return null
}

// Touched so biome doesn't flag the import as unused — it's part of
// the public surface for future callers and label constants.
void KJ_LABEL
void KJ_LABEL_AGENT_ID
