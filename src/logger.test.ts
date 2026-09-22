import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import pino from 'pino'

import { REDACT_PATHS } from './logger'

/**
 * La red de debajo: hoy ningún log vuelca un `agent:input` entero, pero el día
 * que alguien lo haga, el entorno de la conversación (con la clave del
 * proveedor dentro) no puede acabar en `docker logs`.
 */
describe('el logger tapa lo que no puede salir', () => {
    function loguea(obj: Record<string, unknown>): string {
        let out = ''
        const sink = new Writable({
            write(chunk, _enc, done) {
                out += chunk.toString()
                done()
            },
        })
        pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink).info(obj, 'x')
        return out
    }

    const PISTA = 'zzzz-no-debe-salir-zzzz'

    test('el entorno de la conversación, dentro de un payload', () => {
        const out = loguea({ payload: { agent_id: 1, session_env: { API_KEY: PISTA } } })
        expect(out).not.toContain(PISTA)
        expect(out).toContain('"agent_id":1')
    })

    test('y suelto', () => {
        expect(loguea({ session_env: { API_KEY: PISTA } })).not.toContain(PISTA)
    })
})
