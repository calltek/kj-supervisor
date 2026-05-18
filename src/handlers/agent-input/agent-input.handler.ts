/**
 * Handler for `agent:input`. Delivers a user message into the live
 * stdio stream of the named agent. Acks synchronously: the supervisor
 * either wrote the line (`accepted: true`) or no stream is open for
 * that agent right now (`ok: false`).
 *
 * The real outcome of the message — the assistant's response — comes
 * back as `agent:output` events from the same agent's stream, not on
 * this ack.
 */

import type { KJLogger } from '../../logger'
import {
    type AgentInputPayload,
    type ControlCommandAck,
    WS_ERROR_CODES,
    type WsErrorPayload,
} from '../../protocol'
import type { AgentStreamManager } from '../../agent-stream/stream-manager'

export interface AgentInputHandlerDeps {
    streams: AgentStreamManager
    logger: KJLogger
}

export class AgentInputHandler {
    private readonly streams: AgentStreamManager
    private readonly logger: KJLogger

    constructor(deps: AgentInputHandlerDeps) {
        this.streams = deps.streams
        this.logger = deps.logger.child({ component: 'agent-input' })
    }

    handle(payload: AgentInputPayload): ControlCommandAck {
        const result = this.streams.write(payload)
        if (result.ok) {
            this.logger.debug(
                { request_id: payload.request_id, agent_id: payload.agent_id },
                'agent:input delivered'
            )
            return { ok: true, accepted: true }
        }

        const error: WsErrorPayload = {
            code:
                result.reason === 'no_stream'
                    ? WS_ERROR_CODES.AGENT_NOT_RUNNING
                    : WS_ERROR_CODES.INTERNAL_ERROR,
            message:
                result.reason === 'no_stream'
                    ? `agent ${payload.agent_id} has no live stream`
                    : 'failed to write to agent stdin',
            retryable: result.reason !== 'no_stream',
        }
        return { ok: false, error }
    }
}
