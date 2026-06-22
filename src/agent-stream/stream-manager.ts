/**
 * Owns the per-agent attach-stream pipeline. Each live container has
 * an `AgentStream` here: an attach duplex from dockerode, a
 * demultiplexed stdout that feeds an NDJSON parser, and a writable
 * stdin used by `agent:input`.
 *
 * Lifecycle:
 *   - `attach(agent_id, container_id, session_id)` opens the docker
 *     attach and starts forwarding output as supervisor → control
 *     pushes.
 *   - `write(agent_id, message)` wraps a user message into Claude
 *     Code's stream-json input shape and writes it to stdin.
 *   - `detach(agent_id)` stops forwarding and releases the duplex.
 *
 * Stdout/stderr are demultiplexed by dockerode. stderr is logged
 * locally (it carries our wrapper's pino lines from the container's
 * main.ts) and never forwarded — the operator only wants the
 * stream-json content.
 */

import { PassThrough } from 'node:stream'

import type { KJDocker } from '../docker/client/client'
import type { KJLogger } from '../logger'
import type { AgentInputPayload } from '../protocol'
import { isMcpEnvelope, type McpDispatcher, type McpEnvelope } from './mcp-dispatcher'
import { classifyStreamEvent, type ClassifierContext } from './stream-classifier'
import { NDJSONStreamParser } from './stream-parser'

export interface AgentStreamClient {
    push(event: string, payload: unknown): void
}

interface AgentStream {
    agent_id: number
    container_id: string
    session_id: string
    stream: NodeJS.ReadWriteStream
    seq: number
    /**
     * Phase B routing table. Maps the conversation's `session_id`
     * (UUID, the same one claude uses for `--resume`) to its
     * `conversation_id` (the BD primary key). Populated when the
     * supervisor receives `agent:input` so it can stamp `agent:output`
     * envelopes with the correct conversation_id when they come back
     * from the container.
     */
    conversation_id_by_session: Map<string, number>
    /**
     * Sibling routing table for the kj-mcp `user_*` tools: maps the
     * conversation's session_id to the Contact.id the operator-gateway
     * resolved when dispatching `agent:input`. The McpDispatcher reads
     * the latest contact_id touched by the most recent input to stamp
     * outbound `mcp:request` payloads.
     */
    contact_id_by_session: Map<string, number>
    /**
     * Last conversation session the supervisor wrote to this stream.
     * The MCP dispatcher uses it to pick the contact_id to stamp on
     * `mcp:request` calls coming back from the container — the agent
     * doesn't know which contact it's talking to right now, the
     * supervisor does.
     */
    last_active_session_id: string | null
}

export interface AgentStreamManagerDeps {
    docker: KJDocker
    client: AgentStreamClient
    logger: KJLogger
    /**
     * Optional: receives MCP envelopes the container emits on its
     * stdout. When absent (e.g. older test setups), MCP lines are
     * dropped silently — the wrapper just stops talking to the MCP
     * subprocess.
     */
    mcp?: McpDispatcher
}

export class AgentStreamManager {
    private readonly docker: KJDocker
    private readonly client: AgentStreamClient
    private readonly logger: KJLogger
    private readonly streams = new Map<number, AgentStream>()
    private readonly mcp?: McpDispatcher

    constructor(deps: AgentStreamManagerDeps) {
        this.docker = deps.docker
        this.client = deps.client
        this.logger = deps.logger.child({ component: 'agent-stream' })
        this.mcp = deps.mcp
    }

    /**
     * Return the contact_id the most recent input for this agent was
     * routed to, or undefined when no input has flowed through this
     * stream yet (a freshly-spawned agent that has only received MCP
     * tool calls from boot prompts, for example).
     *
     * The MCP dispatcher uses this to stamp `mcp:request` payloads
     * coming back from the container — the agent itself never sees a
     * contact id, the supervisor binds the call to the conversation it
     * came from.
     */
    getActiveContactId(agent_id: number): number | undefined {
        const entry = this.streams.get(agent_id)
        if (!entry?.last_active_session_id) return undefined
        return entry.contact_id_by_session.get(entry.last_active_session_id)
    }

    /**
     * Write an MCP envelope into the container's stdin. Used by the
     * dispatcher to deliver `mcp:response` acks (and any future push
     * topics — none live today). Returns false when no stream exists
     * (container is gone or never spawned locally).
     */
    writeMcp(agent_id: number, envelope: McpEnvelope): boolean {
        const entry = this.streams.get(agent_id)
        if (!entry) return false
        try {
            entry.stream.write(`${JSON.stringify(envelope)}\n`)
            return true
        } catch (err) {
            this.logger.warn(
                {
                    agent_id,
                    err: err instanceof Error ? err.message : String(err),
                },
                'failed to write MCP envelope to container stdin'
            )
            return false
        }
    }

    /**
     * Write a control envelope (NOT an MCP envelope, NOT stream-json
     * input) into the container's stdin. The wrapper's stdin dispatcher
     * recognises these by their `type` field. Used for `skills_changed`
     * (skills hot-reload) — a fire-and-forget signal to recycle the
     * claude pool so a fresh skill catalog is picked up. Returns false
     * when no stream exists (container gone / never spawned locally).
     */
    writeControl(agent_id: number, envelope: { type: string; [k: string]: unknown }): boolean {
        const entry = this.streams.get(agent_id)
        if (!entry) return false
        try {
            entry.stream.write(`${JSON.stringify(envelope)}\n`)
            return true
        } catch (err) {
            this.logger.warn(
                {
                    agent_id,
                    err: err instanceof Error ? err.message : String(err),
                },
                'failed to write control envelope to container stdin'
            )
            return false
        }
    }

    /**
     * Attach to a container's stdio. Idempotent: a second call for the
     * same agent_id is a no-op (we already have a stream).
     */
    async attach(opts: {
        agent_id: number
        container_id: string
        session_id: string
        /**
         * OPEN conversation routes (session_id → conversation_id) from
         * the control. Pre-seeds the routing map so agent:output gets
         * stamped with the right conversation_id from the first turn,
         * even before any agent:input this run. Optional/empty for old
         * control versions or agents with no open conversations.
         */
        conversations?: ReadonlyArray<{ session_id: string; conversation_id: number }>
    }): Promise<void> {
        if (this.streams.has(opts.agent_id)) {
            this.logger.debug({ agent_id: opts.agent_id }, 'attach skipped — already streaming')
            return
        }

        const log = this.logger.child({
            agent_id: opts.agent_id,
            container_id: opts.container_id,
        })

        log.info('attaching to container stdio…')
        let stream: NodeJS.ReadWriteStream
        try {
            stream = await this.docker.attachContainer(opts.container_id)
        } catch (err) {
            log.error(
                { err: err instanceof Error ? err.message : String(err) },
                'failed to attach to container stdio'
            )
            return
        }
        log.info('attach duplex opened, wiring demux and parser')

        const stdout = new PassThrough()
        const stderr = new PassThrough()
        this.docker.demuxAttachStream(stream, stdout, stderr)

        const entry: AgentStream = {
            agent_id: opts.agent_id,
            container_id: opts.container_id,
            session_id: opts.session_id,
            stream,
            seq: 0,
            conversation_id_by_session: new Map(
                (opts.conversations ?? []).map((c) => [c.session_id, c.conversation_id])
            ),
            contact_id_by_session: new Map(),
            last_active_session_id: null,
        }
        this.streams.set(opts.agent_id, entry)

        const ctx: ClassifierContext = {
            agent_id: opts.agent_id,
            session_id: opts.session_id,
            next_seq: () => ++entry.seq,
        }

        const parser = new NDJSONStreamParser({
            onEvent: (event) => this.dispatch(event, ctx, entry),
            logger: this.logger,
        })

        stdout.on('data', (chunk: Buffer) => parser.push(chunk))
        stdout.on('end', () => parser.end())

        stderr.on('data', (chunk: Buffer) => {
            // Wrapper-level pino logs from the container's main.ts. We
            // surface them locally so the operator can grep `docker logs
            // kj-supervisor` for cross-correlation, but never forward
            // them as agent output (they aren't part of Claude Code's
            // conversation).
            log.debug({ stderr: chunk.toString('utf8').trim() }, 'agent stderr')
        })

        stream.on('end', () => {
            log.info('agent stream ended')
            this.streams.delete(opts.agent_id)
        })
        stream.on('error', (err) => {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'agent stream error'
            )
        })

        log.info('attached to agent stdio')
    }

    /**
     * Send a user message into the agent. Phase B: wraps the message
     * in an `{type:"input", conversation_session_id, message}` envelope
     * that kj-agent-base understands and routes to the right per-
     * conversation claude process. The supervisor also keeps a
     * session_id → conversation_id map so it can stamp every output
     * the container emits with the routing key the backend needs.
     *
     * If conversation_session_id is absent the agent falls back to its
     * default session (Phase A behaviour) — useful for old test paths.
     */
    write(payload: AgentInputPayload): { ok: boolean; reason?: string } {
        const entry = this.streams.get(payload.agent_id)
        if (!entry) return { ok: false, reason: 'no_stream' }

        // Remember the (session_id → conversation_id) mapping so we can
        // tag agent:output events with conversation_id when the
        // container emits them.
        const sessionForInput = payload.conversation_session_id ?? entry.session_id
        if (payload.conversation_session_id && payload.conversation_id !== undefined) {
            entry.conversation_id_by_session.set(
                payload.conversation_session_id,
                payload.conversation_id
            )
        }
        // Same idea for contact_id — but the MCP user_* tools pick the
        // contact from `last_active_session_id` rather than mapping by
        // a session id the agent never sees. Persist both so we can
        // reconstruct intent after restarts.
        if (payload.contact_id !== undefined) {
            entry.contact_id_by_session.set(sessionForInput, payload.contact_id)
        }
        entry.last_active_session_id = sessionForInput

        const envelope: Record<string, unknown> = {
            type: 'input',
            conversation_session_id: sessionForInput,
            message: payload.message,
        }
        // Attachments: forward the content blocks verbatim. The wrapper sets
        // the claude stdin `content` to this array (image/document media the
        // model can SEE) instead of the plain message string.
        if (payload.content_blocks?.length) envelope.content_blocks = payload.content_blocks
        if (payload.contact_name) envelope.contact_name = payload.contact_name
        if (payload.contact_id !== undefined) envelope.contact_id = payload.contact_id
        // Bounded, contact-scoped recent history (KUJI-36). The wrapper
        // prepends it as opening context ONLY when it starts the session
        // FRESH (cold wake) instead of --resume-ing the full transcript.
        if (payload.recent_context) envelope.recent_context = payload.recent_context
        // Fire-and-forget (webhook): the wrapper reaps this session fast after
        // the turn instead of keeping it warm. Pure passthrough.
        if (payload.ephemeral) envelope.ephemeral = true
        const line = `${JSON.stringify(envelope)}\n`

        try {
            entry.stream.write(line)
            return { ok: true }
        } catch (err) {
            this.logger.warn(
                {
                    agent_id: payload.agent_id,
                    err: err instanceof Error ? err.message : String(err),
                },
                'failed to write to agent stdin'
            )
            return { ok: false, reason: 'write_failed' }
        }
    }

    /**
     * Detach from a container (e.g. after it stops). Best-effort: the
     * attach stream may already be closed by the daemon.
     */
    detach(agent_id: number): void {
        const entry = this.streams.get(agent_id)
        if (!entry) return
        try {
            entry.stream.end()
        } catch {
            // ignore — stream may already be torn down
        }
        this.streams.delete(agent_id)
        this.logger.debug({ agent_id }, 'detached from agent stdio')
    }

    /** Drop every active stream (shutdown). */
    detachAll(): void {
        for (const id of [...this.streams.keys()]) this.detach(id)
    }

    private dispatch(
        payload: Record<string, unknown>,
        ctx: ClassifierContext,
        entry: AgentStream
    ): void {
        // kj-mcp envelope: the wrapper tagged this line as belonging to
        // the MCP subprocess, not Claude Code. Bypass the classifier
        // entirely and hand it off to the dispatcher. When the
        // dispatcher isn't wired (unit tests, older deployments) the
        // line is dropped silently — the wrapper just stops getting
        // responses for that request.
        if (isMcpEnvelope(payload)) {
            // Cast is safe — isMcpEnvelope just confirmed the marker.
            // See note on the predicate's signature for the why.
            const envelope = payload as unknown as McpEnvelope
            if (this.mcp) {
                this.mcp.onContainerLine(entry.agent_id, envelope)
            } else {
                this.logger.debug(
                    { agent_id: entry.agent_id, kind: envelope.kind },
                    'mcp envelope dropped — dispatcher not configured'
                )
            }
            return
        }

        // Phase B: kj-agent-base emits `{conversation_session_id, event}`
        // envelopes. Unwrap and remember which conversation_id we
        // should attach to the agent:output push.
        //
        // Phase A fallback: if there's no envelope (raw stream-json
        // event), treat the payload itself as the event and route to
        // the agent's default session.
        let event: Record<string, unknown>
        let conversation_session_id: string | undefined
        if (
            typeof payload.conversation_session_id === 'string' &&
            payload.event !== undefined &&
            typeof payload.event === 'object' &&
            payload.event !== null
        ) {
            conversation_session_id = payload.conversation_session_id
            event = payload.event as Record<string, unknown>
        } else {
            event = payload
        }

        const conversation_id = conversation_session_id
            ? entry.conversation_id_by_session.get(conversation_session_id)
            : undefined

        // Patch the classifier context so the session_id stamped on the
        // output report matches the conversation's session (not just
        // the agent's default).
        const ctxForEvent: ClassifierContext = conversation_session_id
            ? { ...ctx, session_id: conversation_session_id }
            : ctx

        const classified = classifyStreamEvent(event, ctxForEvent)
        const output =
            conversation_id !== undefined
                ? { ...classified.output, conversation_id }
                : classified.output
        this.client.push('agent:output', output)
        if (classified.auth_required) {
            this.client.push('agent:auth_required', classified.auth_required)
        }
        if (classified.error) {
            this.client.push('agent:error', classified.error)
        }
        if (classified.metrics) {
            this.client.push('agent:metrics', classified.metrics)
        }
    }
}
