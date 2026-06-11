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
import { isMutableTag } from './image-tag'

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

        // Decide whether to trust the local cache or pull fresh.
        //
        // MUTABLE tags (:latest, :dev, :main, …) are rewritten in place by
        // CI — a cached copy goes stale silently. For those we MUST pull so
        // a registry rebuild reaches the VPS (the prod bug: a cached
        // base:latest never refreshed, the agent booted the old image and
        // hung). The pull of an already-current image is cheap (manifest
        // check, no layer re-download).
        //
        // IMMUTABLE tags (:0.1.0, :sha-…) and LOCALLY-BUILT images
        // (:dev-local, :local — never in a registry) keep the old
        // behaviour: a cached copy IS the source of truth, skip the pull.
        // For a mutable tag with no registry match (a locally-built
        // :latest), the pull fails and we fall back to the cache below.
        const cached = await this.docker.imageExistsLocally(payload.image_tag)
        const mutable = isMutableTag(payload.image_tag)
        if (cached && !mutable) {
            log.info(
                { image_tag: payload.image_tag },
                'image cached locally (immutable tag); skipping pull'
            )
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
                // Pull failed. If we have a local copy, use it — this is
                // the dev case (a locally-built :latest / mutable tag with
                // no registry match) and the long-standing fallback for a
                // registry hiccup on an already-cached image. Only hard-
                // fail when there's nothing on disk to run.
                if (cached) {
                    log.warn(
                        { image_tag: payload.image_tag, err: errMessage(err) },
                        'image pull failed; falling back to cached copy'
                    )
                    pullHeartbeat.update(`using cached ${payload.image_tag} (pull failed)`)
                } else {
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
        }
        pullHeartbeat.stop()

        // Seed SHORT_TERM memories onto the persistent volume BEFORE
        // the agent container runs. The control sends every memory it
        // wants the agent to start with in `payload.memories`; we drop
        // each one under /home/agent/.claude/memories/<name>. Skipped
        // entirely when the array is empty (no-op cost) and for alpine
        // smoke containers (no volume to seed).
        const homeVolume = payload.image_tag.startsWith('alpine')
            ? undefined
            : `kj-agent-${payload.agent_id}-home`
        if (homeVolume) {
            try {
                this.status.push({
                    agent_id: payload.agent_id,
                    status: 'SPAWNING',
                    last_action: `seeding ${payload.memories.length} memorie(s), ${payload.skills.length} skill(s), ${(payload.mcp_servers ?? []).length} mcp(s)`,
                    last_action_at: Date.now(),
                })
                // First: hand the volume root to UID 1000. A named volume is
                // created root:root, shadowing the image's chown, so without
                // this the agent can't mkdir its session cwd at runtime and
                // `claude` dies with ENOENT (silent agent). Must run before
                // the seeds and unconditionally.
                await this.docker.ensureVolumeOwnership(homeVolume)
                // Always purge .claude/memories/ first, even when the
                // payload has zero memories — that's how we clean up
                // after the operator unassigns / renames / deletes.
                // The directory itself stays (preserves owner UID).
                await this.docker.seedVolumeFiles({
                    volume_name: homeVolume,
                    target_dir: '.claude/memories',
                    purge: true,
                    files: payload.memories.map((m) => ({
                        path: m.path,
                        content: m.content,
                        readonly: m.readonly,
                    })),
                })

                // Seed skills the same way: each entry's `path` is
                // already <name>/SKILL.md (the control synthesised the
                // frontmatter), dropped under .claude/skills/ where
                // Claude Code auto-discovers them. Purge first so an
                // unassigned/renamed/archived skill disappears. NOTE:
                // syncBuiltinSkills in the agent wrapper also writes
                // under .claude/skills/ at boot (e.g. kj-mcp) — purge
                // here only clears operator skills the supervisor owns;
                // the wrapper re-lays its built-ins after. They don't
                // collide as long as operator skill names never shadow a
                // built-in (kj-mcp).
                await this.docker.seedVolumeFiles({
                    volume_name: homeVolume,
                    target_dir: '.claude/skills',
                    purge: true,
                    files: payload.skills.map((s) => ({
                        path: s.path,
                        content: s.content,
                        readonly: true,
                    })),
                })

                // Materialise the assigned external MCP servers to
                // .kj/mcp-servers.json. We write the raw list (NOT a
                // .mcp.json) — agent-base owns the merge with the
                // built-in kj-mcp and knows its local port. Always
                // written (even as []) so an unassign clears it. env
                // values arrive decrypted; the file lives only in the
                // agent's own volume.
                const mcpServers = payload.mcp_servers ?? []
                await this.docker.seedVolumeFiles({
                    volume_name: homeVolume,
                    target_dir: '.kj',
                    files: [
                        {
                            path: 'mcp-servers.json',
                            content: JSON.stringify(mcpServers, null, 2),
                            readonly: true,
                        },
                    ],
                })

                // Also seed a CLAUDE.md "project memory" index at the
                // agent's home root. Claude Code auto-discovers
                // CLAUDE.md by walking up from cwd, so this is the
                // cheapest way to make the agent aware of its
                // assigned memories without modifying its system
                // prompt or the wrapper.
                const claudeMd = buildClaudeMdIndex(payload.memories)
                await this.docker.seedVolumeFiles({
                    volume_name: homeVolume,
                    target_dir: '.',
                    files: [
                        {
                            path: 'CLAUDE.md',
                            content: claudeMd,
                            // Writable so the operator can choose to
                            // surface extra context later if needed,
                            // but the auto-content is regenerated on
                            // every spawn.
                            readonly: false,
                        },
                    ],
                })
            } catch (err) {
                log.error({ err: errMessage(err) }, 'volume seed failed')
                this.status.push({
                    agent_id: payload.agent_id,
                    status: 'ERROR',
                    container_id: null,
                    last_action: `volume seed failed: ${errMessage(err)}`,
                    last_action_at: Date.now(),
                })
                return
            }
        }

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
                // Persistent /home/agent volume — keeps the claude
                // transcript (.claude/projects/.../<session>.jsonl),
                // skills, memories across stop+start. Docker creates the
                // volume on first use. Skip for alpine smoke containers.
                home_volume_name: homeVolume,
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
            conversations: payload.conversations,
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
        const env: Record<string, string> = {
            ...payload.env,
            KJ_SESSION_ID: payload.session_id,
        }
        // Inject the Claude credential under the env var that matches
        // the token type. API_KEY uses ANTHROPIC_API_KEY (Console
        // pay-per-use); everything else (including legacy payloads
        // without token_type) defaults to CLAUDE_CODE_OAUTH_TOKEN.
        if (payload.token_type === 'API_KEY') {
            env.ANTHROPIC_API_KEY = payload.oauth_token
        } else {
            env.CLAUDE_CODE_OAUTH_TOKEN = payload.oauth_token
        }
        return env
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

/**
 * Build the CLAUDE.md index that ships with every seeded volume.
 * Lists the memories the agent has on disk, points to their path,
 * and tells the agent to read them as authoritative context for
 * tone/policies/identity. Claude Code reads CLAUDE.md by walking
 * up from `cwd` so this single file at /home/agent/CLAUDE.md is
 * enough — no system prompt change required.
 */
function buildClaudeMdIndex(memories: ReadonlyArray<{ path: string }>): string {
    const lines: string[] = [
        '# Kujira agent — memorias',
        '',
        'Esta organización te ha confiado un conjunto de **memorias** ' +
            'que viven en `/home/agent/.claude/memories/`. Son ficheros ' +
            'markdown que el operador escribe a mano para que tú tengas ' +
            'siempre presente el tono, la identidad, las políticas y ' +
            'cualquier información relevante de la org.',
        '',
        '## Reglas',
        '',
        '- **Léelas siempre antes de responder** algo importante, ' +
            'aunque no las hayas leído nunca: pueden cambiar entre turnos.',
        '- Trátalas como **fuente de verdad**: si una memoria contradice ' +
            'lo que has aprendido durante el chat, gana la memoria.',
        '- Si te preguntan por su contenido, léelas con la tool `Read` ' +
            'y resume con tus palabras.',
        '- Si no encuentras información sobre algo en las memorias, ' +
            'dilo claramente — no inventes.',
        '',
        '## Memorias disponibles',
        '',
    ]
    if (memories.length === 0) {
        lines.push('_(Ninguna por ahora — la org aún no te ha asignado memorias.)_')
    } else {
        for (const m of memories.slice().sort((a, b) => a.path.localeCompare(b.path))) {
            lines.push(`- \`/home/agent/.claude/memories/${m.path}\``)
        }
    }
    lines.push('')
    return lines.join('\n')
}
