/**
 * Handler de `agent:sessions:purge`: borrar del volumen del agente lo que
 * guarda de unas conversaciones que el control ya ha eliminado (un contacto
 * suprimido, una sesión de operador borrada).
 *
 * Dos pasos, y los dos hacen falta:
 *  1. Si el agente está vivo, se le avisa por stdin (`purge_sessions`): el
 *     envoltorio mata esos procesos y borra lo suyo. Sin esto, un proceso vivo
 *     podría volver a escribir el transcript justo después de borrarlo.
 *  2. Después, siempre, un ayudante sobre el volumen borra las mismas rutas.
 *     Es lo que funciona con el agente parado y con imágenes que aún no
 *     conocen el aviso.
 *
 * El ack espera a que el borrado termine: el comando es de entrega
 * garantizada, y un ack antes de tiempo dejaría en el control un «hecho» que
 * no lo está. Un fallo del ayudante es reintentable.
 */

import type { AgentStreamManager } from '../../agent-stream/stream-manager'
import type { KJDocker } from '../../docker/client/client'
import type { KJLogger } from '../../logger'
import { type ControlCommandAck, WS_ERROR_CODES } from '../../protocol'
import { isValidSessionId, purgeScript } from './session-paths'

/**
 * Tipo local, como `session_env` en su día: `protocol.ts` se descarga de
 * producción y este comando no existe allí hasta que se despliegue
 * calltek/kj-backend#974. Cuando llegue, se cambia por el de `protocol.ts`.
 */
export interface AgentSessionsPurgePayload {
    request_id: string
    agent_id: number
    session_ids: string[]
}

/** Lo que tarda el envoltorio en matar un proceso (SIGTERM, y SIGKILL a los 5 s). */
const LIVE_KILL_GRACE_MS = 6_000

export interface AgentSessionsPurgeHandlerDeps {
    docker: Pick<KJDocker, 'runVolumeScript'>
    streams: Pick<AgentStreamManager, 'writeControl'>
    logger: KJLogger
    /** Para los tests: la espera entre el aviso y el borrado. */
    sleep?: (ms: number) => Promise<void>
}

export class AgentSessionsPurgeHandler {
    private readonly logger: KJLogger
    private readonly sleep: (ms: number) => Promise<void>

    constructor(private readonly deps: AgentSessionsPurgeHandlerDeps) {
        this.logger = deps.logger.child({ component: 'agent-sessions-purge' })
        this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    }

    async handle(payload: AgentSessionsPurgePayload): Promise<ControlCommandAck> {
        const session_ids = (payload.session_ids ?? []).filter(isValidSessionId)
        const log = this.logger.child({
            agent_id: payload.agent_id,
            request_id: payload.request_id,
        })
        if (session_ids.length === 0) return { ok: true, accepted: true }

        const live = this.deps.streams.writeControl(payload.agent_id, {
            type: 'purge_sessions',
            session_ids,
        })
        if (live) await this.sleep(LIVE_KILL_GRACE_MS)

        try {
            const { code } = await this.deps.docker.runVolumeScript({
                volume_name: `kj-agent-${payload.agent_id}-home`,
                script: purgeScript(session_ids),
            })
            if (code !== 0) throw new Error(`purge helper exited ${code}`)
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'sessions purge failed'
            )
            return {
                ok: false,
                error: {
                    code: WS_ERROR_CODES.INTERNAL_ERROR,
                    message: 'failed to delete the sessions from the agent volume',
                    retryable: true,
                },
            }
        }
        log.info({ sessions: session_ids.length, live }, 'sessions purged from agent volume')
        return { ok: true, accepted: true }
    }
}
