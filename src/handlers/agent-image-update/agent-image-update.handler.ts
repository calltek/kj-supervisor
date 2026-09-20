/**
 * Handler for `agent:image:update`. Pulls a fresh copy of the agent's
 * image from the registry and recreates the container if requested.
 *
 *   1. Ack { ok: true, accepted: true } — straight away, before any of
 *      the work below. The drain in particular can take as long as the
 *      agent's turn, and the control must not read that as a lost ack.
 *   2. In the background:
 *      - Find the existing container (if any).
 *      - Push status SPAWNING + "pulling <tag>" while docker pulls.
 *      - If a container existed, drain it first when asked to (see
 *        `drainTimeoutFor`): the agent finishes its turn and exits on
 *        its own instead of having it cut.
 *      - If a container existed AND restart_after is true, recreate
 *        it under the same name preserving env / mounts / labels.
 *        Reattach stdio so the conversation keeps flowing.
 *      - If a container existed AND restart_after is false, stop +
 *        remove it and leave the agent STOPPED. The control starts it
 *        again with a full agent:spawn (that is how it reseeds the
 *        volume), so today this is the path every update takes.
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
import { describeDockerRunFailure } from '../../docker/spawn-error'
import type { OperationTracker } from '../../docker/operation-tracker/operation-tracker'
import type { KJLogger } from '../../logger'
import type { AgentImageUpdatePayload, ControlCommandAck, WsErrorPayload } from '../../protocol'
import type { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'
import { StatusHeartbeat } from '../../reporters/status-heartbeat/status-heartbeat'

// Graceful image swap (KJ-22): before replacing the container, ask the agent
// to finish its turn(s) and exit on its own (no turn cut). How long we wait
// for that comes from the control (`drain_timeout_ms`, a platform setting —
// kj-backend §6, 2026-09-19): a number of ms, or `null` for no limit at all,
// because a task can legitimately run for hours and cutting it loses it. A
// turn that stops making progress is given up by the wrapper itself, so it
// does not hold the swap forever.
//
// This default only applies to a control that predates the field: it keeps
// the old behaviour (at most 3 min, then force the swap — which also covers
// an OLD wrapper that predates `drain` and ignores it; harmless if the agent
// was idle). Tunable by env for that transition.
const DEFAULT_DRAIN_TIMEOUT_MS =
    Number.parseInt(process.env.KJ_IMAGE_SWAP_DRAIN_TIMEOUT_MS ?? '', 10) || 180_000
const DRAIN_POLL_MS = 2_000

export interface AgentImageUpdateHandlerDeps {
    docker: KJDocker
    status: AgentStatusReporter
    streams: AgentStreamManager
    tracker: OperationTracker
    logger: KJLogger
    /** Tests only: the drain limit used when the control sends none. */
    default_drain_timeout_ms?: number
    /** Tests only: how often the drain checks whether the agent exited. */
    drain_poll_ms?: number
}

export class AgentImageUpdateHandler {
    private readonly docker: KJDocker
    private readonly status: AgentStatusReporter
    private readonly streams: AgentStreamManager
    private readonly tracker: OperationTracker
    private readonly logger: KJLogger
    private readonly default_drain_timeout_ms: number
    private readonly drain_poll_ms: number

    constructor(deps: AgentImageUpdateHandlerDeps) {
        this.docker = deps.docker
        this.status = deps.status
        this.streams = deps.streams
        this.tracker = deps.tracker
        this.logger = deps.logger.child({ component: 'agent-image-update' })
        this.default_drain_timeout_ms = deps.default_drain_timeout_ms ?? DEFAULT_DRAIN_TIMEOUT_MS
        this.drain_poll_ms = deps.drain_poll_ms ?? DRAIN_POLL_MS
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

        // 3. There is a container to replace. Track it across the whole
        //    drain + stop/swap: its drain-exit, kill and destroy are all OURS.
        //    Without this the events-watcher sees the old container die and
        //    pushes a spurious "external die" STOPPED that races (and usually
        //    beats) the status we push next — on a swap, a healthy freshly-
        //    imaged agent shown as STOPPED (and a fleet rollout's canary
        //    aborted). We only track the OLD id; a NEW container stays
        //    untracked so a genuine crash of it IS reported.
        this.tracker.track(existing)

        //    Drain it first (KJ-22): ask the wrapper to finish its in-flight
        //    turn(s) and exit on its own, so no conversation is cut mid-reply.
        const drain_timeout_ms = this.drainTimeoutFor(payload, log)
        if (drain_timeout_ms !== false) {
            await this.gracefulDrain(payload.agent_id, existing, drain_timeout_ms, log)
        }

        // 4. restart_after=false → stop + remove. The control brings it back
        //    with a full agent:spawn once it sees the STOPPED.
        if (!payload.restart_after) {
            log.info(
                { container_id: existing },
                'pull complete, stopping container per restart_after=false'
            )
            try {
                await this.docker.stopContainer(existing, { force: true })
                await this.docker.removeContainer(existing)
                this.tracker.untrack(existing)
                this.status.push({
                    agent_id: payload.agent_id,
                    status: 'STOPPED',
                    container_id: null,
                    last_action: `image refreshed (${payload.image_tag})`,
                    last_action_at: Date.now(),
                })
            } catch (err) {
                this.tracker.untrack(existing)
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

        // 5. restart_after=true: swap the container with one based on the
        //    freshly-pulled image, preserving its env + mounts so the agent
        //    reconnects to the same session and volume.
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
            this.tracker.untrack(existing)
            swapHeartbeat.stop()
            log.error({ err: errMessage(err) }, 'recreate failed')
            this.status.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id: null,
                last_action: describeDockerRunFailure(err, 'recreate failed'),
                last_action_at: Date.now(),
            })
            return
        }
        this.tracker.untrack(existing)
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

    /**
     * How long to drain before replacing the container: a number of ms,
     * `null` for no limit, or `false` for no drain at all.
     *
     *  - The control sent `drain_timeout_ms` → honour it, whatever
     *    `restart_after` says: `null` waits for as long as the turn takes, a
     *    number caps the wait. Every update goes out with restart_after=false
     *    today (the control respawns to reseed the volume), so without this
     *    the drain would never run at all.
     *  - It didn't (a control that predates the field) → exactly what this
     *    supervisor did before: drain with the default cap on a swap, and stop
     *    straight away on restart_after=false. That control only waits a
     *    fixed 3 min for the STOPPED before respawning, so draining there
     *    could leave the agent updated but stopped.
     */
    private drainTimeoutFor(
        payload: AgentImageUpdatePayload,
        log: KJLogger
    ): number | null | false {
        const requested = payload.drain_timeout_ms
        if (requested === undefined) {
            return payload.restart_after ? this.default_drain_timeout_ms : false
        }
        if (requested === null) return null
        if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 0) {
            return requested
        }
        log.warn(
            { drain_timeout_ms: requested },
            'invalid drain_timeout_ms from the control — using the default'
        )
        return this.default_drain_timeout_ms
    }

    /**
     * Graceful drain before an image update (KJ-22). Send a `drain` control
     * envelope to the wrapper; it finishes any in-flight turn and exits on its
     * own. We poll until that exit, up to `timeout_ms` — or with no deadline
     * at all when it is `null`. On timeout (or no live stream) we just return
     * and the caller's stop/recreate force-kills, cutting the turn.
     *
     * With no limit this waits for as long as the turn runs, on purpose: the
     * wrapper gives up a turn that stops making progress, so a hung one does
     * not hold it forever. What it would hold for ever is a wrapper that
     * predates `drain` (2026-06-26) and ignores it: an image pinned to an
     * older build, or a `:latest` container nobody has respawned since (the
     * spawn re-pulls mutable tags).
     */
    private async gracefulDrain(
        agent_id: number,
        container_id: string,
        timeout_ms: number | null,
        log: KJLogger
    ): Promise<void> {
        // Read the container's current run BEFORE asking it to drain. The
        // wrapper exits, but the agent's restart policy (unless-stopped) has
        // Docker start it again ~100 ms later, so a poll every 2 s almost never
        // catches it "not running": a new start (StartedAt / RestartCount
        // moved) is the exit too. Checking only for "not running" left every
        // drain running to its deadline — and a drain with no limit, forever.
        const before = await this.containerRun(container_id)
        if (!before?.running) {
            log.debug('drain: container not running — nothing to drain')
            return
        }
        const sent = this.streams.writeControl(agent_id, { type: 'drain' })
        if (!sent) {
            log.debug('drain: no live stream to the agent — replacing it without draining')
            return
        }
        // It can be a long wait: say what we're waiting for instead of
        // leaving the pull's last line up. Same status the pull left.
        this.status.push({
            agent_id,
            status: 'SPAWNING',
            container_id,
            last_action: 'waiting for the current turn to finish before updating',
            last_action_at: Date.now(),
        })
        log.info(
            { timeout_ms: timeout_ms ?? 'none' },
            'draining agent before the update — waiting for its turn to end'
        )
        const deadline = timeout_ms === null ? Number.POSITIVE_INFINITY : Date.now() + timeout_ms
        for (;;) {
            const now = await this.containerRun(container_id)
            if (
                !now?.running ||
                now.restarting ||
                now.started_at !== before.started_at ||
                now.restart_count > before.restart_count
            ) {
                log.info('drain: agent exited cleanly — proceeding')
                return
            }
            if (Date.now() >= deadline) {
                log.warn('drain: timed out waiting for idle — forcing it (in-flight turn cut)')
                return
            }
            await new Promise((r) => setTimeout(r, this.drain_poll_ms))
        }
    }

    /** The container's current run, or null when it's gone/unreadable. */
    private async containerRun(container_id: string): Promise<{
        running: boolean
        restarting: boolean
        started_at: string | undefined
        restart_count: number
    } | null> {
        try {
            const info = await this.docker.inspect(container_id)
            return {
                running: info.State?.Running === true,
                restarting: info.State?.Restarting === true,
                started_at: info.State?.StartedAt,
                restart_count: info.RestartCount ?? 0,
            }
        } catch {
            return null
        }
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
