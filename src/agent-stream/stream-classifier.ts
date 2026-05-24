/**
 * Routes a single Claude Code stream-json event to the right
 * supervisor → control push. One event in, zero or more pushes out.
 *
 * The supervisor doesn't try to interpret the agent's reasoning — it
 * forwards every event verbatim as `agent:output` so the operator UI
 * can render it however it wants. On top of that, three side-effects:
 *
 *  - `system/api_retry` with `error: "authentication_failed"` →
 *    `agent:auth_required` (the operator must regenerate the OAuth
 *    token).
 *  - Other categorised errors → `agent:error`.
 *  - `type: "result"` with `usage` + `total_cost_usd` → `agent:metrics`
 *    with per-turn deltas. The control accumulates them into
 *    `Agent.tokens_used` / `cost_micro`. No double-counting risk: the
 *    periodic loop sends `tokens_delta: '0'` (it only refreshes uptime).
 */

import type {
    AgentAuthRequiredReport,
    AgentErrorReport,
    AgentMetricsReport,
    AgentOutputReport,
} from '../protocol'

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
    metrics?: AgentMetricsReport
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

    // result events carry the per-turn usage breakdown and the total
    // cost in USD. Convert to wire shape (BigInt strings, cost in
    // micro-EUR-equivalents — we store dollars-as-micros for now since
    // claude only reports USD; the conversion to EUR happens at display
    // time when we wire FX). Skip when usage isn't present.
    if (event.type === 'result') {
        const tokens_delta = sumUsageTokens(event.usage)
        const cost_delta_micro = readCostMicro(event.total_cost_usd)
        if (tokens_delta > 0n || cost_delta_micro > 0n) {
            classified.metrics = {
                agent_id: ctx.agent_id,
                tokens_delta: tokens_delta.toString(),
                cost_delta_micro: cost_delta_micro.toString(),
            }
        }
    }

    return classified
}

/**
 * Pull the token-counting fields off a Claude `usage` object. We sum
 * input + output + cache because the cost field already amortises
 * cache reads vs writes; for "tokens used" the operator wants the
 * total throughput, not the billable subset.
 */
function sumUsageTokens(usage: unknown): bigint {
    if (!usage || typeof usage !== 'object') return 0n
    const u = usage as Record<string, unknown>
    const fields = [
        'input_tokens',
        'output_tokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
    ]
    let total = 0n
    for (const f of fields) {
        const v = u[f]
        if (typeof v === 'number' && Number.isFinite(v)) {
            total += BigInt(Math.max(0, Math.round(v)))
        }
    }
    return total
}

/** USD float → integer micro-units (1 USD = 1_000_000). */
function readCostMicro(value: unknown): bigint {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0n
    return BigInt(Math.round(value * 1_000_000))
}

function readStringField(obj: Record<string, unknown>, key: string): string | undefined {
    const value = obj[key]
    return typeof value === 'string' ? value : undefined
}
