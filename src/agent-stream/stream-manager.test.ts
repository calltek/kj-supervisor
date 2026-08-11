import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

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
