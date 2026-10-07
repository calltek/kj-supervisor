import { describe, expect, test } from 'bun:test'
import type { KJLogger } from '../../logger'
import { AgentSessionsPurgeHandler } from './agent-sessions-purge.handler'
import { purgeScript, sessionPaths } from './session-paths'

const SID = '1f0c2a9e-7b1d-4c3e-9a55-0d2b6c7e8f90'

const logger = {
    child: () => logger,
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
} as unknown as KJLogger

function setup(opts: { live?: boolean; code?: number } = {}) {
    const scripts: string[] = []
    const controls: unknown[] = []
    const order: string[] = []
    const handler = new AgentSessionsPurgeHandler({
        logger,
        sleep: async () => {
            order.push('wait')
        },
        streams: {
            writeControl: (_id, env) => {
                controls.push(env)
                order.push('control')
                return opts.live ?? false
            },
        },
        docker: {
            runVolumeScript: async ({ script }) => {
                scripts.push(script)
                order.push('helper')
                return { code: opts.code ?? 0 }
            },
        },
    })
    return { handler, scripts, controls, order }
}

describe('session paths', () => {
    test('las rutas son las del envoltorio: cwd, carpeta de transcripts codificada', () => {
        expect(sessionPaths(SID)).toContain(`conv/${SID}`)
        expect(sessionPaths(SID)).toContain(`.claude/projects/-home-agent-conv-${SID}`)
        expect(sessionPaths('a_b')).toContain('.claude/projects/-home-agent-conv-a-b')
    })

    test('un id que podría salirse del volumen no llega a ninguna ruta', () => {
        expect(() => sessionPaths('../../etc')).toThrow()
        expect(() => purgeScript(['x; rm -rf /'])).toThrow()
    })
})

describe('AgentSessionsPurgeHandler', () => {
    test('con el agente vivo: avisa, espera y borra', async () => {
        const { handler, scripts, controls, order } = setup({ live: true })
        const ack = await handler.handle({ request_id: 'r', agent_id: 7, session_ids: [SID] })
        expect(ack.ok).toBe(true)
        expect(controls).toEqual([{ type: 'purge_sessions', session_ids: [SID] }])
        expect(order).toEqual(['control', 'wait', 'helper'])
        expect(scripts[0]).toContain(`rm -rf -- "/v/conv/${SID}"`)
    })

    test('con el agente parado: borra igual, sin esperar', async () => {
        const { handler, order } = setup({ live: false })
        await handler.handle({ request_id: 'r', agent_id: 7, session_ids: [SID] })
        expect(order).toEqual(['control', 'helper'])
    })

    test('los ids que no pasan el filtro se descartan; sin ninguno no se toca el disco', async () => {
        const { handler, scripts } = setup()
        const ack = await handler.handle({ request_id: 'r', agent_id: 7, session_ids: ['../x'] })
        expect(ack.ok).toBe(true)
        expect(scripts).toHaveLength(0)
    })

    test('si el ayudante falla, el control puede reintentar', async () => {
        const { handler } = setup({ code: 1 })
        const ack = await handler.handle({ request_id: 'r', agent_id: 7, session_ids: [SID] })
        expect(ack.ok).toBe(false)
        if (!ack.ok) expect(ack.error.retryable).toBe(true)
    })
})
