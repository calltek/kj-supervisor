/**
 * Routes a single Claude Code stream-json event to the right
 * supervisor → control push. One event in, zero or more pushes out.
 *
 * The supervisor doesn't try to interpret the agent's reasoning — it
 * forwards every event verbatim as `agent:output` so the operator UI
 * can render it however it wants. On top of that, two side-effects:
 *
 *  - `system/api_retry` with `error: "authentication_failed"` →
 *    `agent:auth_required` (the operator must regenerate the OAuth
 *    token).
 *  - Other categorised errors → `agent:error`.
 *
 * Metrics from the final `result` event are NOT pushed from here; the
 * periodic agent:metrics loop already covers tokens/cost reporting.
 * Adding a duplicate would risk double-counting on the control side.
 */

import type { AgentAuthRequiredReport, AgentErrorReport, AgentOutputReport } from '../protocol'

/** Categorised non-auth error codes Claude Code emits in `api_retry`. */
const NON_AUTH_ERROR_CATEGORIES: ReadonlySet<AgentErrorReport['category']> = new Set([
    'rate_limit',
    'billing_error',
    'server_error',
    'invalid_request',
    'max_output_tokens',
    'oauth_org_not_allowed',
    'unknown',
])

export interface ClassifiedEvent {
    output: AgentOutputReport
    auth_required?: AgentAuthRequiredReport
    error?: AgentErrorReport
}

export interface ClassifierContext {
    agent_id: number
    session_id: string
    next_seq: () => number
}

export function classifyStreamEvent(
    event: Record<string, unknown>,
    ctx: ClassifierContext
): ClassifiedEvent {
    const timestamp = Date.now()
    const output: AgentOutputReport = {
        agent_id: ctx.agent_id,
        session_id: ctx.session_id,
        seq: ctx.next_seq(),
        timestamp,
        event,
    }

    const classified: ClassifiedEvent = { output }

    // Auth-failure: the synthetic assistant carries error: "authentication_failed",
    // and api_retry events carry the same field with the failure category.
    const error = readStringField(event, 'error')
    if (error === 'authentication_failed') {
        classified.auth_required = { agent_id: ctx.agent_id, timestamp }
        return classified
    }

    // api_retry surfaces other categorised errors. Forward the message
    // so the operator UI can show it without parsing raw events.
    if (event.type === 'system' && event.subtype === 'api_retry' && error) {
        const category = NON_AUTH_ERROR_CATEGORIES.has(error as AgentErrorReport['category'])
            ? (error as AgentErrorReport['category'])
            : 'unknown'
        classified.error = {
            agent_id: ctx.agent_id,
            category,
            message: readStringField(event, 'message') ?? error,
            timestamp,
        }
    }

    return classified
}

function readStringField(obj: Record<string, unknown>, key: string): string | undefined {
    const value = obj[key]
    return typeof value === 'string' ? value : undefined
}
