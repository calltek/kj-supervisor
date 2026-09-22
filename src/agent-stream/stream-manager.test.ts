import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import { AgentInputHandler } from '../handlers/agent-input/agent-input.handler'
import { McpDispatcher } from './mcp-dispatcher'
import { AgentStreamManager } from './stream-manager'

const silentLogger = (() => {
    const noop = () => {}
    const fake = {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        fatal: noop,
        trace: noop,
        child: () => fake,
    }
    return fake as unknown as ConstructorParameters<typeof AgentStreamManager>[0]['logger']
})()

class FakeClient {
    push(): void {}
}

/**
 * Minimal docker stub: `attachContainer` hands back a duplex we never feed
 * (resolveTarget reads the routing maps, not the stream), and
 * `demuxAttachStream` is a no-op. Enough to let `attach()` register a stream
 * entry so the per-session maps exist.
 */
function makeDocker() {
    return {
        attachContainer: async () => new PassThrough(),
        demuxAttachStream: () => {},
    } as never
}

function makeManager(): AgentStreamManager {
    const mcp = new McpDispatcher({
        sendRequest: async () => ({ ok: true, data: {} }),
        writeToContainer: () => true,
        resolveTarget: () => ({}),
        logger: silentLogger,
    })
    return new AgentStreamManager({
        docker: makeDocker(),
        client: new FakeClient(),
        logger: silentLogger,
        mcp,
    })
}

/**
 * KUJI-84: resolveTarget must return the conversation/contact bound to the
 * session that ACTUALLY made the MCP call — not the last person who wrote.
 * These tests exercise the real routing maps (no mock of resolveTarget),
 * which is the gap the dispatcher test left open.
 */
describe('AgentStreamManager.resolveTarget (KUJI-84)', () => {
    // Replays the real bug: Elena (148/152) then Bego (149/153) both active in
    // the same container; an MCP call from Elena's session must resolve to
    // Elena even though Bego wrote last.
    async function twoActiveConversations(): Promise<AgentStreamManager> {
        const m = makeManager()
        await m.attach({
            agent_id: 7,
            container_id: 'c1',
            session_id: 'agent-default',
            conversations: [
                { session_id: 'sess-elena', conversation_id: 148 },
                { session_id: 'sess-bego', conversation_id: 149 },
            ],
        })
        // Each agent:input primes contact_id_by_session and moves
        // last_active_session_id. Elena writes first, then Bego writes LAST.
        m.write({
            request_id: 'r1',
            agent_id: 7,
            message: 'hola soy Elena',
            conversation_id: 148,
            conversation_session_id: 'sess-elena',
            contact_id: 152,
        })
        m.write({
            request_id: 'r2',
            agent_id: 7,
            message: 'hola soy Bego',
            conversation_id: 149,
            conversation_session_id: 'sess-bego',
            contact_id: 153,
        })
        return m
    }

    test("a call from Elena's session resolves to Elena, though Bego wrote last", async () => {
        const m = await twoActiveConversations()
        // Bego is last_active; the buggy heuristic would return Bego here.
        expect(m.resolveTarget(7, 'sess-elena')).toEqual({
            conversation_id: 148,
            contact_id: 152,
        })
    })

    test("a call from Bego's session resolves to Bego", async () => {
        const m = await twoActiveConversations()
        expect(m.resolveTarget(7, 'sess-bego')).toEqual({
            conversation_id: 149,
            contact_id: 153,
        })
    })

    test('no session (old image) falls back to last-active — Bego, who wrote last', async () => {
        const m = await twoActiveConversations()
        // Documented legacy fallback: undefined session → last_active_session_id.
        expect(m.resolveTarget(7, undefined)).toEqual({
            conversation_id: 149,
            contact_id: 153,
        })
    })

    test('unknown session resolves to empty (backend then rejects, no leak)', async () => {
        const m = await twoActiveConversations()
        expect(m.resolveTarget(7, 'sess-does-not-exist')).toEqual({
            conversation_id: undefined,
            contact_id: undefined,
        })
    })

    test('pre-seeded conversation with no input yet → conversation_id but no contact_id', async () => {
        const m = makeManager()
        await m.attach({
            agent_id: 9,
            container_id: 'c2',
            session_id: 'agent-default',
            conversations: [{ session_id: 'sess-cold', conversation_id: 200 }],
        })
        // No write() for this session: conversation_id is pre-seeded from
        // attach, contact_id is still unknown. Safer than stealing another
        // session's contact — backend returns MCP_CONTACT_REQUIRED for user_*.
        expect(m.resolveTarget(9, 'sess-cold')).toEqual({
            conversation_id: 200,
            contact_id: undefined,
        })
    })

    test('unknown agent resolves to empty', () => {
        const m = makeManager()
        expect(m.resolveTarget(999, 'whatever')).toEqual({})
    })
})

/** Un gestor con una sesión enganchada, devolviendo lo que se le escribe. */
async function attached(): Promise<{ manager: AgentStreamManager; written: () => string[] }> {
    const lines: string[] = []
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => lines.push(chunk.toString()))
    const manager = new AgentStreamManager({
        docker: {
            attachContainer: async () => stream,
            demuxAttachStream: () => {},
        } as never,
        client: new FakeClient(),
        logger: silentLogger,
        mcp: new McpDispatcher({
            sendRequest: async () => ({ ok: true, data: {} }),
            writeToContainer: () => true,
            resolveTarget: () => ({}),
            logger: silentLogger,
        }),
    })
    await manager.attach({
        agent_id: 1,
        container_id: 'c1',
        session_id: 's1',
    })
    return { manager, written: () => lines }
}

/**
 * #277 — el nivel de razonamiento por conversación tiene que LLEGAR al
 * contenedor. Viajaba en el turno desde el control y se quedaba aquí: el
 * envelope reenviaba el modelo y se dejaba el esfuerzo por el camino, así que
 * el ajuste existía de punta a punta menos en el último metro.
 *
 * Los dos van juntos a propósito: ambos son banderas de arranque, y el wrapper
 * recicla la sesión al cambiarlas — mandarlos en el mismo turno hace que un
 * solo reciclado cubra los dos.
 */
describe('el turno lleva modelo Y esfuerzo al contenedor (#277)', () => {
    test('el esfuerzo llega, junto al modelo', async () => {
        const { manager, written } = await attached()

        manager.write({
            request_id: 'r1',
            agent_id: 1,
            message: 'hola',
            conversation_session_id: 's1',
            model: 'claude-haiku-4-5',
            effort: 'max',
        } as never)

        const envelope = JSON.parse(written().join('').trim())
        expect(envelope.model).toBe('claude-haiku-4-5')
        expect(envelope.effort).toBe('max')
    })

    test('sin esfuerzo, la clave no viaja (el contenedor usa el suyo)', async () => {
        const { manager, written } = await attached()

        manager.write({
            request_id: 'r1',
            agent_id: 1,
            message: 'hola',
            conversation_session_id: 's1',
        } as never)

        const envelope = JSON.parse(written().join('').trim())
        expect('effort' in envelope).toBe(false)
    })
})

/**
 * Los límites de las tareas largas (kj-backend §6, 2026-09-19): el control los
 * estampa en cada turno y el wrapper los aplica por sesión. Si se quedaran
 * aquí, como le pasó al esfuerzo (#277), el ajuste de «Ajustes globales» no
 * llegaría nunca y el contenedor seguiría cortando a los 30 minutos.
 */
describe('el turno lleva los límites de las tareas largas al contenedor', () => {
    test('los dos llegan', async () => {
        const { manager, written } = await attached()

        manager.write({
            request_id: 'r1',
            agent_id: 1,
            message: 'descarga esto',
            conversation_session_id: 's1',
            stall_limit_ms: 1_800_000,
            background_task_limit_ms: 21_600_000,
        } as never)

        const envelope = JSON.parse(written().join('').trim())
        expect(envelope.stall_limit_ms).toBe(1_800_000)
        expect(envelope.background_task_limit_ms).toBe(21_600_000)
    })

    test('un 0 también viaja: sólo se omite lo que no viene', async () => {
        const { manager, written } = await attached()

        manager.write({
            request_id: 'r1',
            agent_id: 1,
            message: 'hola',
            conversation_session_id: 's1',
            stall_limit_ms: 0,
            background_task_limit_ms: 0,
        } as never)

        const envelope = JSON.parse(written().join('').trim())
        expect(envelope.stall_limit_ms).toBe(0)
        expect(envelope.background_task_limit_ms).toBe(0)
    })

    test('sin límites en el turno, las claves no viajan (el contenedor usa los suyos)', async () => {
        const { manager, written } = await attached()

        manager.write({
            request_id: 'r1',
            agent_id: 1,
            message: 'hola',
            conversation_session_id: 's1',
        } as never)

        const envelope = JSON.parse(written().join('').trim())
        expect('stall_limit_ms' in envelope).toBe(false)
        expect('background_task_limit_ms' in envelope).toBe(false)
    })
})

/**
 * #529 — la generación de credenciales se lee DEL CONTENEDOR al engancharse.
 *
 * Es la pieza que le permite al control distinguir el contenedor que lleva las
 * credenciales de ahora del que se está muriendo con las de antes: al cambiar
 * credenciales el agente se reinicia, y el viejo sigue unos segundos fallando
 * con las caducadas. Su aviso volvía a cerrarle el cuadro de escribir al
 * operador justo después de que lo arreglara.
 *
 * Se lee del entorno del propio contenedor, que es donde el control la horneó
 * junto al secreto, y no de lo que nadie nos pase: así vale igual para un
 * arranque, para un re-enganche tras reiniciarnos y para una recreación por
 * cambio de imagen, sin que ninguno tenga que acordarse.
 */
describe('AgentStreamManager: generación de credenciales (#529)', () => {
    /**
     * Engancha un contenedor cuyo `docker inspect` devuelve el entorno dado,
     * le mete una línea de stream-json y devuelve lo que se empujó al control.
     */
    async function avisoDeUnContenedorCon(
        env: string[] | null,
        opts: { inspectFalla?: boolean } = {}
    ): Promise<Record<string, unknown> | undefined> {
        const duplex = new PassThrough()
        const docker = {
            attachContainer: async () => duplex,
            // El de verdad demultiplexa el marco de docker; aquí basta con
            // volcar el duplex en stdout para que el parser vea las líneas.
            demuxAttachStream: (stream: NodeJS.ReadWriteStream, stdout: NodeJS.WritableStream) => {
                stream.pipe(stdout)
            },
            inspect: async () => {
                if (opts.inspectFalla) throw new Error('no such container')
                return { Config: { Env: env } }
            },
        } as never

        const pushed: Array<{ event: string; payload: Record<string, unknown> }> = []
        const manager = new AgentStreamManager({
            docker,
            client: {
                push(event: string, payload: unknown) {
                    pushed.push({ event, payload: payload as Record<string, unknown> })
                },
            },
            logger: silentLogger,
        })
        await manager.attach({ agent_id: 7, container_id: 'c1', session_id: 'sess' })

        duplex.write(`${JSON.stringify({ type: 'assistant', message: {} })}\n`)
        await new Promise((r) => setTimeout(r, 20))

        return pushed.find((p) => p.event === 'agent:output')?.payload
    }

    test('la lee del entorno y la estampa en el aviso', async () => {
        const salida = await avisoDeUnContenedorCon([
            'KJ_AGENT_ID=7',
            'KJ_CREDENTIALS_EPOCH=1700000000000',
            'KJ_SESSION_ID=sess',
        ])
        expect(salida?.credentials_epoch).toBe(1700000000000)
    })

    test('la generación 0 sí viaja: es «nunca se tocaron», no «no se sabe»', async () => {
        const salida = await avisoDeUnContenedorCon(['KJ_CREDENTIALS_EPOCH=0'])
        expect(salida?.credentials_epoch).toBe(0)
    })

    test('un contenedor sin la variable no manda generación', async () => {
        // Los que ya estaban corriendo antes de este cambio. El control lo lee
        // como «no descartes nada», que es el comportamiento de hoy.
        const salida = await avisoDeUnContenedorCon(['KJ_AGENT_ID=7'])
        expect(salida && 'credentials_epoch' in salida).toBe(false)
    })

    test('un inspect que falla no rompe el enganche ni inventa una generación', async () => {
        const salida = await avisoDeUnContenedorCon(null, { inspectFalla: true })
        expect(salida).toBeDefined()
        expect(salida && 'credentials_epoch' in salida).toBe(false)
    })

    test('un decimal tampoco pasa: el control exige entero y lo descartaría', async () => {
        // Las tres condiciones tienen que ser las MISMAS a los dos lados
        // (número, entero, no negativo). Si divergen, el control tira el valor
        // y el filtro se apaga sin que nada lo diga.
        const salida = await avisoDeUnContenedorCon(['KJ_CREDENTIALS_EPOCH=1.5'])
        expect(salida && 'credentials_epoch' in salida).toBe(false)
    })

    test('lo que no cabe en un Date tampoco sale de aquí', async () => {
        // Nanosegundos: entero y no negativo, pero al otro lado sería un Date
        // inválido que tumba la consulta entera y en silencio.
        const salida = await avisoDeUnContenedorCon(['KJ_CREDENTIALS_EPOCH=1757000000000000000'])
        expect(salida && 'credentials_epoch' in salida).toBe(false)
    })

    test('un negativo tampoco', async () => {
        const salida = await avisoDeUnContenedorCon(['KJ_CREDENTIALS_EPOCH=-1'])
        expect(salida && 'credentials_epoch' in salida).toBe(false)
    })

    test('una variable con basura se ignora, no se manda un NaN', async () => {
        const salida = await avisoDeUnContenedorCon(['KJ_CREDENTIALS_EPOCH=ayer'])
        expect(salida && 'credentials_epoch' in salida).toBe(false)
    })
})

/**
 * Proveedor de modelo por conversación: el control manda en el turno el entorno
 * con el que corre ESA conversación (dirección, clave, modelos) y el wrapper se
 * lo aplica sólo a su proceso. Aquí no se interpreta nada: tiene que llegar al
 * contenedor tal cual, y a ningún otro sitio — lleva claves de API.
 */
describe('el turno lleva el entorno de la conversación al contenedor', () => {
    const PISTA = 'zzzz-no-debe-salir-zzzz'

    test('llega tal cual, con los null que quitan una variable', async () => {
        const { manager, written } = await attached()
        const session_env = {
            ANTHROPIC_BASE_URL: 'https://proveedor.example/api',
            ANTHROPIC_AUTH_TOKEN: PISTA,
            CLAUDE_CODE_OAUTH_TOKEN: null,
        }

        manager.write({
            request_id: 'r1',
            agent_id: 1,
            message: 'hola',
            conversation_session_id: 's1',
            session_env,
        } as never)

        const envelope = JSON.parse(written().join('').trim())
        expect(envelope.session_env).toEqual(session_env)
    })

    test('uno vacío también viaja: sólo se omite lo que no viene', async () => {
        const { manager, written } = await attached()

        manager.write({
            request_id: 'r1',
            agent_id: 1,
            message: 'hola',
            conversation_session_id: 's1',
            session_env: {},
        } as never)

        const envelope = JSON.parse(written().join('').trim())
        expect(envelope.session_env).toEqual({})
    })

    test('sin entorno en el turno, la clave no viaja (la conversación usa el del contenedor)', async () => {
        const { manager, written } = await attached()

        manager.write({
            request_id: 'r1',
            agent_id: 1,
            message: 'hola',
            conversation_session_id: 's1',
        } as never)

        const envelope = JSON.parse(written().join('').trim())
        expect('session_env' in envelope).toBe(false)
    })

    test('no sale en ningún log, ni al entregarse ni al fallar', async () => {
        const logged: string[] = []
        const record =
            (level: string) =>
            (obj: unknown, msg?: string): void => {
                logged.push(`${level} ${JSON.stringify(obj)} ${msg ?? ''}`)
            }
        const capture = {
            info: record('info'),
            warn: record('warn'),
            error: record('error'),
            debug: record('debug'),
            fatal: record('fatal'),
            trace: record('trace'),
            child: (bindings: unknown) => {
                logged.push(`child ${JSON.stringify(bindings)}`)
                return capture
            },
        }
        const logger = capture as unknown as typeof silentLogger

        // Un stdin que revienta al escribir: el camino del fallo es el que
        // loguea, así que es el que más fácil se llevaría el turno entero.
        let roto = false
        const stream = new PassThrough()
        const write = stream.write.bind(stream)
        stream.write = ((...args: Parameters<typeof stream.write>) => {
            if (roto) throw new Error('EPIPE')
            return write(...args)
        }) as typeof stream.write
        const manager = new AgentStreamManager({
            docker: { attachContainer: async () => stream, demuxAttachStream: () => {} } as never,
            client: new FakeClient(),
            logger,
        })
        await manager.attach({ agent_id: 1, container_id: 'c1', session_id: 's1' })
        const handler = new AgentInputHandler({ streams: manager, logger })
        const turno = {
            request_id: 'r1',
            agent_id: 1,
            message: 'hola',
            conversation_session_id: 's1',
            session_env: { ANTHROPIC_AUTH_TOKEN: PISTA },
        } as never

        expect(handler.handle(turno).ok).toBe(true)
        roto = true
        expect(handler.handle(turno).ok).toBe(false)
        // El warmup lleva el mismo entorno y falla por el otro camino de escritura.
        expect(manager.warmup(turno)).toBe(false)
        manager.detach(1)
        expect(handler.handle(turno).ok).toBe(false)

        // Que se haya logueado algo: si no, el test pasaría sin mirar nada.
        expect(logged.some((l) => l.includes('agent:input delivered'))).toBe(true)
        expect(logged.some((l) => l.includes('failed to write to agent stdin'))).toBe(true)
        expect(logged.some((l) => l.includes('failed to write control envelope'))).toBe(true)
        expect(logged.join('\n')).not.toContain(PISTA)
    })
})

/**
 * El warmup de una llamada prepara la sesión ANTES de que empiece: el wrapper
 * la recicla con el modelo y el esfuerzo de la llamada mientras suena. Con un
 * proveedor por conversación, el entorno tiene que viajar también aquí — si no,
 * la sesión se calentaría contra el proveedor equivocado y el primer turno de la
 * llamada tendría que reciclarla otra vez.
 */
describe('el warmup lleva el entorno de la conversación al contenedor', () => {
    test('llega tal cual, junto al modelo y el esfuerzo', async () => {
        const { manager, written } = await attached()
        const session_env = { ANTHROPIC_BASE_URL: 'https://proveedor.example/api', X: null }

        const ok = manager.warmup({
            request_id: 'r1',
            agent_id: 1,
            conversation_session_id: 's1',
            model: 'claude-haiku-4-5',
            effort: 'low',
            session_env,
        } as never)

        expect(ok).toBe(true)
        expect(JSON.parse(written().join('').trim())).toEqual({
            type: 'warmup',
            conversation_session_id: 's1',
            model: 'claude-haiku-4-5',
            effort: 'low',
            session_env,
        })
    })

    test('sin entorno, el sobre es el de siempre', async () => {
        const { manager, written } = await attached()

        manager.warmup({ request_id: 'r1', agent_id: 1, conversation_session_id: 's1' })

        expect(JSON.parse(written().join('').trim())).toEqual({
            type: 'warmup',
            conversation_session_id: 's1',
        })
    })

    test('sin agente enganchado no se entrega', () => {
        const m = makeManager()
        expect(m.warmup({ request_id: 'r1', agent_id: 99, conversation_session_id: 's1' })).toBe(
            false
        )
    })
})

/**
 * Con un proveedor por conversación, el control tarifa cada turno con lo que
 * cobra el proveedor que lo sirvió, así que el `agent:metrics` del turno tiene
 * que decir de qué conversación es. La misma clave que ya lleva `agent:output`.
 */
describe('agent:metrics dice de qué conversación es el turno', () => {
    async function metricasDe(
        linea: Record<string, unknown>
    ): Promise<Record<string, unknown> | undefined> {
        const duplex = new PassThrough()
        const pushed: Array<{ event: string; payload: Record<string, unknown> }> = []
        const manager = new AgentStreamManager({
            docker: {
                attachContainer: async () => duplex,
                demuxAttachStream: (s: NodeJS.ReadWriteStream, stdout: NodeJS.WritableStream) => {
                    s.pipe(stdout)
                },
                inspect: async () => ({ Config: { Env: [] } }),
            } as never,
            client: {
                push(event: string, payload: unknown) {
                    pushed.push({ event, payload: payload as Record<string, unknown> })
                },
            },
            logger: silentLogger,
        })
        await manager.attach({
            agent_id: 7,
            container_id: 'c1',
            session_id: 'agent-default',
            conversations: [{ session_id: 'sess-a', conversation_id: 148 }],
        })
        // Una conversación que el control da a conocer con el turno, no al
        // engancharse: el mapa se llena por los dos lados. El turno sale por el
        // mismo duplex, así que se vacía antes de meter la línea del agente.
        manager.write({
            request_id: 'r1',
            agent_id: 7,
            message: 'hola',
            conversation_id: 149,
            conversation_session_id: 'sess-b',
        })
        await new Promise((r) => setTimeout(r, 20))
        pushed.length = 0

        duplex.write(`${JSON.stringify(linea)}\n`)
        await new Promise((r) => setTimeout(r, 20))

        return pushed.find((p) => p.event === 'agent:metrics')?.payload
    }

    const RESULT = {
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 20 },
        total_cost_usd: 0.01,
    }

    test('una conversación sembrada al engancharse', async () => {
        const m = await metricasDe({ conversation_session_id: 'sess-a', event: RESULT })
        expect(m?.conversation_id).toBe(148)
        expect(m?.tokens_delta).toBe('120')
    })

    test('una conversación que llegó con el turno', async () => {
        const m = await metricasDe({ conversation_session_id: 'sess-b', event: RESULT })
        expect(m?.conversation_id).toBe(149)
    })

    test('una sesión que no conocemos no se inventa conversación', async () => {
        const m = await metricasDe({ conversation_session_id: 'sess-x', event: RESULT })
        expect(m).toBeDefined()
        expect(m && 'conversation_id' in m).toBe(false)
    })

    test('un evento sin sobre (imagen vieja) tampoco', async () => {
        const m = await metricasDe(RESULT)
        expect(m).toBeDefined()
        expect(m && 'conversation_id' in m).toBe(false)
    })
})
