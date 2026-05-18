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
}

export interface AgentStreamManagerDeps {
    docker: KJDocker
    client: AgentStreamClient
    logger: KJLogger
}

export class AgentStreamManager {
    private readonly docker: KJDocker
    private readonly client: AgentStreamClient
    private readonly logger: KJLogger
    private readonly streams = new Map<number, AgentStream>()

    constructor(deps: AgentStreamManagerDeps) {
        this.docker = deps.docker
        this.client = deps.client
        this.logger = deps.logger.child({ component: 'agent-stream' })
    }

    /**
     * Attach to a container's stdio. Idempotent: a second call for the
     * same agent_id is a no-op (we already have a stream).
     */
    async attach(opts: {
        agent_id: number
        container_id: string
        session_id: string
    }): Promise<void> {
        if (this.streams.has(opts.agent_id)) {
            this.logger.debug({ agent_id: opts.agent_id }, 'attach skipped — already streaming')
            return
        }

        const log = this.logger.child({
            agent_id: opts.agent_id,
            container_id: opts.container_id,
        })

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

        const stdout = new PassThrough()
        const stderr = new PassThrough()
        this.docker.demuxAttachStream(stream, stdout, stderr)

        const entry: AgentStream = {
            agent_id: opts.agent_id,
            container_id: opts.container_id,
            session_id: opts.session_id,
            stream,
            seq: 0,
        }
        this.streams.set(opts.agent_id, entry)

        const ctx: ClassifierContext = {
            agent_id: opts.agent_id,
            session_id: opts.session_id,
            next_seq: () => ++entry.seq,
        }

        const parser = new NDJSONStreamParser({
            onEvent: (event) => this.dispatch(event, ctx),
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
     * Send a user message into the agent. The transport schema is
     * Claude Code's stream-json input shape; the message field of the
     * AgentInputPayload becomes the assistant-visible content.
     */
    write(payload: AgentInputPayload): { ok: boolean; reason?: string } {
        const entry = this.streams.get(payload.agent_id)
        if (!entry) return { ok: false, reason: 'no_stream' }

        const line =
            JSON.stringify({
                type: 'user',
                message: { role: 'user', content: payload.message },
            }) + '\n'

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

    private dispatch(event: Record<string, unknown>, ctx: ClassifierContext): void {
        const classified = classifyStreamEvent(event, ctx)
        this.client.push('agent:output', classified.output)
        if (classified.auth_required) {
            this.client.push('agent:auth_required', classified.auth_required)
        }
        if (classified.error) {
            this.client.push('agent:error', classified.error)
        }
    }
}
