import { describe, expect, test } from 'bun:test'
import type { KJLogger } from '../../logger'
import { ConnectionTestHandler } from './connection-test.handler'

/**
 * What this supervisor reports back for the «Probar» button.
 *
 * The `fetch` is injected rather than replaced globally: these cases are about
 * what is ASKED and what is reported, and a test that needs this machine's
 * network to answer would be measuring the runner instead of the code.
 */

const fakeLogger = {
    child: () => fakeLogger,
    info: () => {},
    error: () => {},
    warn: () => {},
} as unknown as KJLogger

/** A `fetch` that answers per URL and records every call it got. */
function stub(routes: Record<string, () => Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const impl = (async (url: unknown, init?: RequestInit) => {
        const u = String(url)
        calls.push({ url: u, init })
        const key = Object.keys(routes).find((k) => u.includes(k))
        const route = key === undefined ? undefined : routes[key]
        if (!route) return new Response('not stubbed', { status: 404 })
        return route()
    }) as unknown as typeof fetch
    /** The first call, which is the one every case here looks at. */
    const first = () => {
        const c = calls[0]
        if (!c) throw new Error('nobody was called')
        return c
    }
    return { impl, calls, first }
}

const handler = (impl: typeof fetch) =>
    new ConnectionTestHandler({ logger: fakeLogger, fetchImpl: impl })

const run = (check: any, impl: typeof fetch) =>
    handler(impl).handle({ request_id: 'r1', timeout_ms: 5000, check })

const TOKEN = 'oat-de-mentira-para-el-test'

describe('una suscripción de Claude', () => {
    test('se pregunta a Anthropic con Bearer, y nunca con x-api-key', async () => {
        const { impl, first } = stub({
            'api.anthropic.com': () => Response.json({ data: [] }, { status: 200 }),
        })
        const ack = await run({ kind: 'anthropic_oauth', token: TOKEN }, impl)
        expect(ack.ok).toBe(true)
        expect(first().url).toContain('api.anthropic.com/v1/models')
        const headers = first().init?.headers as Record<string, string>
        expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
        expect(headers['x-api-key']).toBeUndefined()
    })

    test('un token que no vale vuelve como su código, sin interpretarlo aquí', async () => {
        const { impl } = stub({
            'api.anthropic.com': () =>
                Response.json(
                    { error: { message: 'OAuth access token is invalid.' } },
                    { status: 401 }
                ),
        })
        const ack = await run({ kind: 'anthropic_oauth', token: TOKEN }, impl)
        if (!ack.ok) throw new Error('debería haber contestado')
        // El supervisor NO decide que sea «credencial rechazada»: eso lo dice
        // el control, con el mismo catálogo que usa para lo que prueba él.
        expect(ack.result.http_status).toBe(401)
        expect(ack.result.body).toContain('invalid')
    })

    test('la dirección no se la inventa quien llama', async () => {
        // Va fija en el supervisor a propósito: mandarla desde el control
        // dejaría que una fila de la base decidiera a dónde va el token.
        const { impl, first } = stub({ 'api.anthropic.com': () => new Response('{}') })
        await run({ kind: 'anthropic_oauth', token: TOKEN }, impl)
        expect(first().url.startsWith('https://api.anthropic.com/')).toBe(true)
    })
})

describe('una dirección de la red del cliente', () => {
    test('se llama tal y como la compuso el control', async () => {
        const { impl, first } = stub({ 'interna.lan': () => new Response('{}', { status: 200 }) })
        await run(
            {
                kind: 'http',
                url: 'https://interna.lan/v1/models',
                method: 'POST',
                headers: { 'x-api-key': 'k' },
                body: { model: 'x' },
            },
            impl
        )
        expect(first().url).toBe('https://interna.lan/v1/models')
        expect(first().init?.method).toBe('POST')
        expect(String(first().init?.body)).toContain('"model":"x"')
    })

    test('no se sigue una redirección, y no se dice a dónde iba', async () => {
        const { impl, calls, first } = stub({
            'interna.lan': () =>
                new Response(null, {
                    status: 302,
                    headers: { location: 'http://169.254.169.254/latest/meta-data/' },
                }),
        })
        const ack = await run({ kind: 'http', url: 'https://interna.lan/v1/models' }, impl)
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(first().init?.redirect).toBe('manual')
        expect(ack.result.redirected).toBe(true)
        expect(calls).toHaveLength(1)
        expect(JSON.stringify(ack.result)).not.toContain('meta-data')
        expect(JSON.stringify(ack.result)).not.toContain('169.254')
    })

    test('que no se llegue se cuenta como tal, no como un fallo del supervisor', async () => {
        const impl = (async () => {
            const err = new TypeError('fetch failed')
            ;(err as any).cause = new Error('connect ECONNREFUSED 192.168.1.50:11434')
            throw err
        }) as unknown as typeof fetch
        const ack = await run({ kind: 'http', url: 'http://192.168.1.50:11434/v1/models' }, impl)
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(ack.result.network_error).toBe('unreachable')
        expect(ack.result.http_status).toBeNull()
    })
})

describe('un Ollama', () => {
    const tags = () =>
        Response.json({ models: [{ name: 'qwen3-coder:30b' }, { name: 'llama3:8b' }] })
    const show = () => Response.json({ model_info: { 'qwen3.context_length': 262144 } })
    const ps = () => Response.json({ models: [{ name: 'qwen3-coder:30b', context_length: 4096 }] })

    test('devuelve lo descargado y LAS DOS ventanas', async () => {
        // Es el dato que nadie veía: el modelo admite 262.144 y el servidor
        // está sirviendo 4.096. La conexión funciona y hay que ir a tocarla.
        const { impl } = stub({ '/api/tags': tags, '/api/show': show, '/api/ps': ps })
        const ack = await run(
            { kind: 'ollama', base_url: 'http://192.168.1.50:11434', model: 'qwen3-coder:30b' },
            impl
        )
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(ack.result.ollama?.models).toEqual(['qwen3-coder:30b', 'llama3:8b'])
        expect(ack.result.ollama?.model_max_context).toBe(262144)
        expect(ack.result.ollama?.served_context).toBe(4096)
    })

    test('la ventana del modelo se busca por el sufijo, no por la familia', async () => {
        // La clave va prefijada con la arquitectura (`qwen3.`, `llama.`), así
        // que adivinarla dejaría muda cualquier arquitectura nueva.
        const { impl } = stub({
            '/api/tags': tags,
            '/api/show': () =>
                Response.json({ model_info: { 'arquitectura-nueva.context_length': 99 } }),
            '/api/ps': ps,
        })
        const ack = await run(
            { kind: 'ollama', base_url: 'http://x:11434', model: 'qwen3-coder:30b' },
            impl
        )
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(ack.result.ollama?.model_max_context).toBe(99)
    })

    test('sin modelo en la conexión sólo se pregunta qué hay descargado', async () => {
        const { impl, calls } = stub({ '/api/tags': tags })
        const ack = await run({ kind: 'ollama', base_url: 'http://x:11434', model: null }, impl)
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(calls).toHaveLength(1)
        expect(ack.result.ollama?.served_context).toBeUndefined()
    })

    test('un Ollama que no contesta no se pregunta tres veces', async () => {
        const impl = (async () => {
            throw new TypeError('fetch failed')
        }) as unknown as typeof fetch
        const ack = await run({ kind: 'ollama', base_url: 'http://x:11434', model: 'm' }, impl)
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(ack.result.network_error).toBe('unreachable')
        expect(ack.result.ollama).toBeUndefined()
    })

    test('que no se sepa la ventana no convierte un motor vivo en uno roto', async () => {
        // Un Ollama viejo no reporta `context_length`, y un modelo que ahora
        // mismo no está cargado no sale en `/api/ps`. Ninguna de las dos cosas
        // dice nada malo de la conexión.
        const { impl } = stub({
            '/api/tags': tags,
            '/api/show': () => new Response('{}', { status: 404 }),
            '/api/ps': () => Response.json({ models: [] }),
        })
        const ack = await run(
            { kind: 'ollama', base_url: 'http://x:11434', model: 'qwen3-coder:30b' },
            impl
        )
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(ack.result.http_status).toBe(200)
        expect(ack.result.ollama?.models.length).toBe(2)
        expect(ack.result.ollama?.model_max_context).toBeUndefined()
        expect(ack.result.ollama?.served_context).toBeUndefined()
    })
})
