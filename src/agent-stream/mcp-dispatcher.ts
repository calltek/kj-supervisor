/**
 * Routes kj-mcp traffic between the in-container MCP subprocess and
 * the control. The MCP itself never opens a network connection; all
 * its calls travel multiplexed on the container's stdio, and the
 * supervisor turns them into Socket.IO traffic to the backend.
 *
 * Wire format (lines on the container's stdio):
 *
 *   { "kj_channel": "mcp", "kind": "request",  "request_id": "...",
 *     "tool": "memory_list", "args": { ... } }
 *
 *   { "kj_channel": "mcp", "kind": "response", "request_id": "...",
 *     "ok": true,  "data":  { ... } }
 *
 *   { "kj_channel": "mcp", "kind": "response", "request_id": "...",
 *     "ok": false, "error": { code, message, retryable } }
 *
 *   { "kj_channel": "mcp", "kind": "push", "topic": "<topic>",
 *     "payload": { ... } }   (no live topic today — see forward below)
 *
 * The `kj_channel` marker lets the wrapper inside the container
 * distinguish MCP-bound input from regular user input it forwards to
 * the claude session. Lines without the marker are treated as plain
 * Claude Code stream-json — the existing path.
 */

import type { KJLogger } from '../logger'
import type { McpRequestAck, WS_ERROR_CODES } from '../protocol'

/** The wire envelopes flowing in either direction. */
export type McpEnvelope = McpRequestEnvelope | McpResponseEnvelope | McpPushEnvelope

export interface McpRequestEnvelope {
    kj_channel: 'mcp'
    kind: 'request'
    request_id: string
    tool: string
    args: Record<string, unknown>
}

export interface McpResponseEnvelope {
    kj_channel: 'mcp'
    kind: 'response'
    request_id: string
    ok: boolean
    data?: Record<string, unknown>
    error?: { code: string; message: string; retryable: boolean }
}

export interface McpPushEnvelope {
    kj_channel: 'mcp'
    kind: 'push'
    topic: string
    payload: Record<string, unknown>
}

/**
 * Recognise an MCP envelope on a line we just parsed. We can't use a
 * `line is McpEnvelope` predicate directly because TS won't let an
 * `interface` satisfy `Record<string, unknown>` — so callers cast at
 * the use site after this check is true.
 */
export function isMcpEnvelope(line: Record<string, unknown>): boolean {
    return line.kj_channel === 'mcp' && typeof line.kind === 'string'
}

/**
 * The outbound side: how the dispatcher reaches the control. We accept
 * a generic emitWithAck for the request path and a void-returning
 * `write` for the response path so the manager can wire it without
 * pulling the full Socket.IO surface.
 */
export interface McpDispatcherDeps {
    /**
     * Send an mcp:request to the control. Resolves with the ack body
     * (success OR error). Rejects only on transport-level failure.
     * The supervisor stamps `agent_id` from its container map and
     * forwards the `request_id` untouched so the in-container MCP
     * can match its own pending promise.
     */
    sendRequest: (
        agent_id: number,
        request_id: string,
        tool: string,
        args: Record<string, unknown>,
        contact_id: number | undefined
    ) => Promise<McpRequestAck>
    /**
     * Write a line to the agent's container stdin. Used to forward the
     * mcp:response (and pushes) back into the container.
     */
    writeToContainer: (agent_id: number, envelope: McpEnvelope) => boolean
    /**
     * Resolve the contact_id the in-container MCP call belongs to.
     * The agent doesn't tell us — the supervisor knows it from the
     * most recent `agent:input` that flowed through that container.
     * Returns undefined when no input has primed the stream yet.
     */
    resolveContactId: (agent_id: number) => number | undefined
    logger: KJLogger
}

export class McpDispatcher {
    private readonly deps: McpDispatcherDeps
    private readonly logger: KJLogger

    constructor(deps: McpDispatcherDeps) {
        this.deps = deps
        this.logger = deps.logger.child({ component: 'mcp-dispatcher' })
    }

    /**
     * Handle a line read from the container's stdout that carries an
     * MCP envelope. Today we only expect `kind: "request"` — the
     * container is a client of the backend's tools, not a server.
     * `response`/`push` shapes are valid envelopes but we drop them
     * with a warn if they ever appear (the container has no reason
     * to send them).
     */
    onContainerLine(agent_id: number, envelope: McpEnvelope): void {
        if (envelope.kind !== 'request') {
            this.logger.warn(
                { agent_id, kind: envelope.kind },
                'unexpected MCP envelope from container (only "request" is supported)'
            )
            return
        }
        // Fire-and-forget: we await the ack but don't block the parser.
        void this.handleRequest(agent_id, envelope)
    }

    /**
     * Forward a backend push to the matching container's stdin so the
     * in-container MCP can react. No live topic uses this today
     * (memory:updated / contact_profile:updated were retired 2026-06-03);
     * kept generic for future push topics (Phase 4 channels).
     */
    forwardPushToContainer(
        agent_id: number,
        topic: string,
        payload: Record<string, unknown>
    ): void {
        const ok = this.deps.writeToContainer(agent_id, {
            kj_channel: 'mcp',
            kind: 'push',
            topic,
            payload,
        })
        if (!ok) {
            // Container not running locally — push is dropped on the
            // floor. The next spawn will seed the fresh memory state
            // via the spawn payload, so missing this push is safe.
            this.logger.debug(
                { agent_id, topic },
                'mcp push not delivered — agent has no live stream'
            )
        }
    }

    private async handleRequest(agent_id: number, request: McpRequestEnvelope): Promise<void> {
        const log = this.logger.child({
            agent_id,
            request_id: request.request_id,
            tool: request.tool,
        })
        log.debug('forwarding mcp request to control')

        const contact_id = this.deps.resolveContactId(agent_id)
        let response: McpResponseEnvelope
        try {
            const ack = await this.deps.sendRequest(
                agent_id,
                request.request_id,
                request.tool,
                request.args,
                contact_id
            )
            response = ack.ok
                ? {
                      kj_channel: 'mcp',
                      kind: 'response',
                      request_id: request.request_id,
                      ok: true,
                      data: ack.data,
                  }
                : {
                      kj_channel: 'mcp',
                      kind: 'response',
                      request_id: request.request_id,
                      ok: false,
                      error: ack.error,
                  }
        } catch (err) {
            // Transport failure (timeout, supervisor not connected to
            // control, etc.) — surface a structured error to the MCP so
            // it can return a proper MCP error to Claude Code instead
            // of hanging forever.
            const message = err instanceof Error ? err.message : String(err)
            log.warn({ err: message }, 'mcp request transport error')
            response = {
                kj_channel: 'mcp',
                kind: 'response',
                request_id: request.request_id,
                ok: false,
                error: {
                    // Match the supervisor-degraded / timeout family in
                    // WS_ERROR_CODES so the MCP error mapping in the
                    // container can be table-driven.
                    code: 'SUPERVISOR_TIMEOUT' as (typeof WS_ERROR_CODES)['SUPERVISOR_TIMEOUT'],
                    message,
                    retryable: true,
                },
            }
        }

        const delivered = this.deps.writeToContainer(agent_id, response)
        if (!delivered) {
            // The container is gone before we got the response — nothing
            // we can do; the in-container MCP will fail its own timeout.
            log.warn('mcp response not delivered — container stream gone')
        }
    }
}
