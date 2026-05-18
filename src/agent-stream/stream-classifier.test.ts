import { describe, expect, test } from 'bun:test'

import { classifyStreamEvent, type ClassifierContext } from './stream-classifier'

function ctx(): ClassifierContext {
    let seq = 0
    return {
        agent_id: 42,
        session_id: '00000000-0000-0000-0000-000000000042',
        next_seq: () => ++seq,
    }
}

describe('classifyStreamEvent', () => {
    test('any event becomes an agent:output with monotonic seq', () => {
        const c = ctx()
        const a = classifyStreamEvent({ type: 'assistant', message: {} }, c)
        const b = classifyStreamEvent({ type: 'user' }, c)
        expect(a.output.seq).toBe(1)
        expect(b.output.seq).toBe(2)
        expect(a.output.agent_id).toBe(42)
        expect(a.output.session_id).toBe('00000000-0000-0000-0000-000000000042')
        expect(a.output.event).toEqual({ type: 'assistant', message: {} })
    })

    test('authentication_failed sibling field triggers agent:auth_required', () => {
        const c = ctx()
        const result = classifyStreamEvent({ type: 'assistant', error: 'authentication_failed' }, c)
        expect(result.auth_required).toEqual({ agent_id: 42, timestamp: result.output.timestamp })
        // Does NOT also classify as a generic agent:error.
        expect(result.error).toBeUndefined()
    })

    test('api_retry with rate_limit becomes a categorised agent:error', () => {
        const c = ctx()
        const result = classifyStreamEvent(
            {
                type: 'system',
                subtype: 'api_retry',
                error: 'rate_limit',
                message: 'Rate limited — waiting 30s',
            },
            c
        )
        expect(result.error).toEqual({
            agent_id: 42,
            category: 'rate_limit',
            message: 'Rate limited — waiting 30s',
            timestamp: result.output.timestamp,
        })
        expect(result.auth_required).toBeUndefined()
    })

    test('api_retry with unknown error category falls back to "unknown"', () => {
        const c = ctx()
        const result = classifyStreamEvent(
            { type: 'system', subtype: 'api_retry', error: 'pigeons_hijacked_the_dns' },
            c
        )
        expect(result.error?.category).toBe('unknown')
        expect(result.error?.message).toBe('pigeons_hijacked_the_dns')
    })

    test('api_retry without an error field stays as plain output', () => {
        const c = ctx()
        const result = classifyStreamEvent({ type: 'system', subtype: 'api_retry' }, c)
        expect(result.error).toBeUndefined()
        expect(result.auth_required).toBeUndefined()
    })
})
