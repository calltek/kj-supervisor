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

describe('lo que la revisión de #45 dejó claro', () => {
    test('una lista recortada viaja con su cuenta, para no hacer de veredicto', async () => {
        // El control decide «ese modelo no está descargado» mirando esta
        // lista. Recortarla sin decirlo mandaría a hacer un pull de 20 GB de
        // algo que ya está ahí.
        const muchos = Array.from({ length: 250 }, (_, i) => ({ name: `modelo-${i}:latest` }))
        const { impl } = stub({ '/api/tags': () => Response.json({ models: muchos }) })
        const ack = await run({ kind: 'ollama', base_url: 'http://x:11434', model: null }, impl)
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(ack.result.ollama?.models).toHaveLength(200)
        expect(ack.result.ollama?.models_total).toBe(250)
    })

    test('una lista que cabe entera no lleva cuenta: sería ruido', async () => {
        const { impl } = stub({
            '/api/tags': () => Response.json({ models: [{ name: 'qwen3-coder:30b' }] }),
        })
        const ack = await run({ kind: 'ollama', base_url: 'http://x:11434', model: null }, impl)
        if (!ack.ok) throw new Error('debería haber contestado')
        expect(ack.result.ollama?.models_total).toBeUndefined()
    })

    test('el plazo es de la COMPROBACIÓN, no de cada petición', async () => {
        // El camino de Ollama hace tres llamadas seguidas. Con un plazo por
        // petición se gastaba el triple de lo que el control espera, y el
        // cliente leía «actualiza tu servidor» teniendo un Ollama lento.
        const plazos: number[] = []
        const impl = (async (_url: unknown, init?: RequestInit) => {
            const signal = init?.signal as AbortSignal & { reason?: unknown }
            plazos.push(Date.now())
            // Que el AbortSignal existe y cada llamada hereda lo que queda se
            // comprueba por el efecto: la tercera ya no tiene presupuesto.
            expect(signal).toBeDefined()
            await new Promise((r) => setTimeout(r, 12))
            return Response.json({ models: [{ name: 'm' }] })
        }) as unknown as typeof fetch

        const handler = new ConnectionTestHandler({ logger: fakeLogger, fetchImpl: impl })
        const ack = await handler.handle({
            request_id: 'r1',
            timeout_ms: 20,
            check: { kind: 'ollama', base_url: 'http://x:11434', model: 'm' },
        })
        if (!ack.ok) throw new Error('debería haber contestado')
        // `/api/tags` contesta; para cuando le toca a `/api/ps` el presupuesto
        // se agotó, así que ni se llama. Lo que NO pasa es gastar 3 × 20 ms.
        expect(plazos.length).toBeLessThan(3)
        expect(ack.result.ollama?.served_context).toBeUndefined()
    })

    test('el cuerpo se lee con el plazo puesto, no después de desarmarlo', async () => {
        // Un endpoint que manda las cabeceras rápido y luego el cuerpo a
        // goteo dejaba el `read()` colgado para siempre: el handler no ackeaba
        // nunca y el socket se quedaba abierto.
        const impl = (async (_url: unknown, init?: RequestInit) => {
            const signal = init?.signal as AbortSignal
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('{'))
                        // Nunca cierra. Sólo el abort puede sacarlo de aquí.
                        signal?.addEventListener('abort', () =>
                            controller.error(new Error('aborted'))
                        )
                    },
                }),
                { status: 200 }
            )
        }) as unknown as typeof fetch

        const handler = new ConnectionTestHandler({ logger: fakeLogger, fetchImpl: impl })
        const ack = await handler.handle({
            request_id: 'r1',
            timeout_ms: 30,
            check: { kind: 'http', url: 'http://x/v1/models' },
        })
        // Lo que se comprueba es que CONTESTA: sin el arreglo, esto no
        // terminaría y el test se quedaría colgado hasta el tope de la suite.
        expect(ack.ok).toBe(true)
    })

    test('el tope del cuerpo no se pasa por el tamaño del último trozo', async () => {
        const gordo = new Uint8Array(100 * 1024).fill(65)
        const impl = (async () => new Response(gordo, { status: 200 })) as unknown as typeof fetch
        const ack = await run({ kind: 'http', url: 'http://x/v1/models' }, impl)
        if (!ack.ok) throw new Error('debería haber contestado')
        expect((ack.result.body ?? '').length).toBe(32 * 1024)
    })

    test('lo que se loguea de un fallo propio es el NOMBRE, no el mensaje', async () => {
        // Con `kind: 'http'` las cabeceras las compone el control y pueden
        // llevar la credencial; un error de undici sobre una cabecera mala es
        // por donde eso asomaría.
        const visto: unknown[] = []
        const logger = {
            child: () => logger,
            info: () => {},
            warn: () => {},
            error: (...args: unknown[]) => visto.push(args),
        } as unknown as KJLogger
        // Un fallo de RED se clasifica y nunca llega al `catch` general, así
        // que para ejercitar esa línea hace falta un fallo propio. El que se
        // usa lleva el secreto en el mensaje, que es lo que se comprueba que
        // no se escribe.
        const explosivo = {
            kind: 'ollama',
            model: 'm',
            get base_url(): string {
                throw new Error('invalid header x-api-key: clave-secreta')
            },
        }

        const handler = new ConnectionTestHandler({
            logger,
            fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
        })
        const ack = await handler.handle({
            request_id: 'r1',
            timeout_ms: 100,
            check: explosivo as never,
        })

        expect(ack.ok).toBe(false)
        expect(visto).toHaveLength(1)
        expect(JSON.stringify(visto)).not.toContain('clave-secreta')
        // Y sí se dice QUÉ pasó, que es para lo que sirve el registro.
        expect(JSON.stringify(visto)).toContain('Error')
    })
})
