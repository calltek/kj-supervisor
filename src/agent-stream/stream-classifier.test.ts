import { describe, expect, test } from 'bun:test'

import { classifyStreamEvent, type ClassifierContext } from './stream-classifier'

function ctx(credentials_epoch?: number): ClassifierContext {
    let seq = 0
    return {
        agent_id: 42,
        session_id: '00000000-0000-0000-0000-000000000042',
        next_seq: () => ++seq,
        credentials_epoch,
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

    test('result event with usage emits agent:metrics with summed delta + cost in micros', () => {
        const c = ctx()
        const out = classifyStreamEvent(
            {
                type: 'result',
                usage: {
                    input_tokens: 100,
                    output_tokens: 250,
                    cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 1000,
                },
                total_cost_usd: 0.01234,
            },
            c
        )
        expect(out.metrics).toEqual({
            agent_id: 42,
            tokens_delta: '1400',
            cost_delta_micro: '12340',
        })
    })

    test('result event with zero usage emits no metrics (avoids no-op writes)', () => {
        const c = ctx()
        const out = classifyStreamEvent({ type: 'result', usage: {}, total_cost_usd: 0 }, c)
        expect(out.metrics).toBeUndefined()
    })

    test('non-result events do not emit metrics', () => {
        const c = ctx()
        const out = classifyStreamEvent({ type: 'assistant', message: {} }, c)
        expect(out.metrics).toBeUndefined()
    })
})

/**
 * #529 — cada aviso dice con qué generación de credenciales corre el
 * contenedor que lo emite.
 *
 * El control la compara con la del agente para descartar lo que diga un
 * contenedor que ya no lleva las credenciales de ahora: al cambiarlas el agente
 * se reinicia y el viejo sigue unos segundos fallando con las caducadas, y su
 * aviso volvía a cerrarle el cuadro de escribir al operador.
 */
describe('generación de credenciales en los avisos (#529)', () => {
    test('cuando se conoce, viaja en el output y en el aviso de credencial', () => {
        const c = ctx(1_700_000_000_000)
        const salida = classifyStreamEvent({ type: 'assistant', message: {} }, c)
        expect(salida.output.credentials_epoch).toBe(1_700_000_000_000)

        const auth = classifyStreamEvent({ type: 'assistant', error: 'authentication_failed' }, c)
        expect(auth.auth_required?.credentials_epoch).toBe(1_700_000_000_000)
    })

    test('la generación 0 viaja igual: es «nunca se tocaron», no «no se sabe»', () => {
        // Distinguirlas importa — el control trata el 0 como una generación más
        // (la de los agentes a los que nadie cambió las credenciales todavía) y
        // la ausencia como «no filtres nada».
        const salida = classifyStreamEvent({ type: 'assistant', message: {} }, ctx(0))
        expect(salida.output.credentials_epoch).toBe(0)
    })

    test('cuando no se conoce, el campo no se manda', () => {
        // Un contenedor anterior a esto, o un inspect que falló. El control lo
        // lee como «no descartes nada», que es el lado bueno por el que
        // equivocarse: un sello de más se borra al primer turno bueno.
        const c = ctx()
        const salida = classifyStreamEvent({ type: 'assistant', message: {} }, c)
        expect('credentials_epoch' in salida.output).toBe(false)

        const auth = classifyStreamEvent({ type: 'assistant', error: 'authentication_failed' }, c)
        expect(auth.auth_required && 'credentials_epoch' in auth.auth_required).toBe(false)
    })
})
