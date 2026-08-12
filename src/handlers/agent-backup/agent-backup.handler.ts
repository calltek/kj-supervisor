/**
 * Handlers for `agent:backup` and `agent:restore`.
 *
 * Backup: tar the agent's /home/agent docker volume (gzip) and PUT it straight
 * to a pre-signed R2 URL — the bytes never touch the control. Synchronous (the
 * control awaits the size in the ack; the dispatch has a long ceiling).
 *
 * Restore: DESTRUCTIVE — stop+remove the live container (it holds the volume),
 * wipe + extract the tarball onto the volume, and leave the agent STOPPED. The
 * operator (or a follow-up spawn) starts it back; we don't auto-respawn here
 * because that needs the spawn payload (oauth token, image…) which the control
 * owns. `restart_after` is reported for the control to act on.
 */

import type { KJDocker } from '../../docker/client/client'
import type { KJLogger } from '../../logger'
import type {
    AgentBackupAck,
    AgentBackupPayload,
    AgentRestoreAck,
    AgentRestorePayload,
} from '../../protocol'
import type { OperationTracker } from '../../docker/operation-tracker/operation-tracker'
import type { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'

export interface AgentBackupHandlerDeps {
    docker: KJDocker
    status: AgentStatusReporter
    tracker: OperationTracker
    logger: KJLogger
}

const volumeName = (agent_id: number): string => `kj-agent-${agent_id}-home`

export class AgentBackupHandler {
    private readonly docker: KJDocker
    private readonly status: AgentStatusReporter
    private readonly tracker: OperationTracker
    private readonly logger: KJLogger
    /** Contenedores ya descongelados en esta copia (thaw es idempotente). */
    private readonly thawed = new Set<string>()

    constructor(deps: AgentBackupHandlerDeps) {
        this.docker = deps.docker
        this.status = deps.status
        this.tracker = deps.tracker
        this.logger = deps.logger.child({ component: 'agent-backup' })
    }

    async handleBackup(payload: AgentBackupPayload): Promise<AgentBackupAck> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
        })
        log.info({ freeze: payload.freeze_container === true }, 'agent:backup received')
        // El agente, congelado mientras se lee su disco — si el operador lo pidió.
        //
        // Congelar (`pause`) y no parar: parar mata el proceso y hay que
        // arrancarlo de vuelta, con lo que una copia podría dejar al agente
        // caído si el arranque falla. Congelar no puede fallar hacia ese lado —
        // descongelar es devolver la señal, no reconstruir nada. A cambio, sus
        // conexiones abiertas pueden caducar durante la pausa, que es el precio
        // que el operador acepta al activarlo.
        const frozen = await this.freezeIfAsked(payload, log)
        try {
            const { size_bytes, parts } = await this.docker.backupVolume(
                volumeName(payload.agent_id),
                payload.upload_url,
                payload.multipart,
                // El tar ya terminó: nadie está leyendo el volumen y el agente
                // puede seguir aunque la subida dure varios minutos más.
                frozen ? () => this.thaw(frozen, log) : undefined
            )
            log.info({ size_bytes, parts: parts?.length ?? 0 }, 'agent:backup uploaded')
            // `parts` only comes back when the tarball didn't fit in a single
            // PUT — the control needs the ETags to seal the object (#263).
            return {
                ok: true,
                request_id: payload.request_id,
                size_bytes,
                ...(parts?.length ? { parts } : {}),
            }
        } catch (err) {
            log.error({ err: errMessage(err) }, 'agent:backup failed')
            return {
                ok: false,
                request_id: payload.request_id,
                error: {
                    code: 'INTERNAL_ERROR',
                    message: `backup failed: ${errMessage(err)}`,
                    retryable: false,
                },
            }
        } finally {
            // La red de seguridad: si el tar reventó antes de imprimir su
            // marca, o el aviso no llegó, un agente congelado se quedaría así
            // para siempre. `thaw` es idempotente, así que llamarlo dos veces
            // no cuesta nada y no llamarlo una sí.
            if (frozen) await this.thaw(frozen, log)
        }
    }

    /**
     * Congela el contenedor del agente si la copia lo pidió. Devuelve el id
     * congelado, o null si no había que congelar o no se pudo.
     *
     * Que no se pueda NO aborta la copia: una copia hecha en caliente sigue
     * valiendo para casi todo, y negarse a copiar por no poder congelar sería
     * cambiar un riesgo pequeño por la certeza de no tener nada.
     */
    private async freezeIfAsked(
        payload: AgentBackupPayload,
        log: KJLogger
    ): Promise<string | null> {
        if (payload.freeze_container !== true) return null
        const container = (await this.docker.listKjContainers().catch(() => [])).find(
            (c) => c.agent_id === payload.agent_id
        )
        if (!container) {
            log.warn('no hay contenedor que congelar — se copia en caliente')
            return null
        }
        try {
            // Rastreado para que el vigilante de eventos no lo lea como una
            // pausa externa y le cambie el estado al agente por el camino.
            this.tracker.track(container.container_id)
            await this.docker.pauseContainer(container.container_id)
            log.info({ container_id: container.container_id }, 'agente congelado para la copia')
            return container.container_id
        } catch (err) {
            this.tracker.untrack(container.container_id)
            log.warn({ err: errMessage(err) }, 'no se pudo congelar — se copia en caliente')
            return null
        }
    }

    /** Descongela. Idempotente: descongelar lo ya descongelado no es un error. */
    private async thaw(container_id: string, log: KJLogger): Promise<void> {
        if (this.thawed.has(container_id)) return
        this.thawed.add(container_id)
        try {
            await this.docker.unpauseContainer(container_id)
            log.info({ container_id }, 'agente descongelado')
        } catch (err) {
            log.error({ err: errMessage(err) }, 'NO se pudo descongelar el agente')
        } finally {
            this.tracker.untrack(container_id)
        }
    }

    async handleRestore(payload: AgentRestorePayload): Promise<AgentRestoreAck> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
        })
        log.info({ restart_after: payload.restart_after }, 'agent:restore received')
        try {
            // The live container holds the volume open — stop + remove it so we
            // can wipe + extract cleanly.
            const existing = (await this.docker.listKjContainers()).find(
                (c) => c.agent_id === payload.agent_id
            )
            if (existing) {
                await this.docker.stopContainer(existing.container_id)
                await this.docker.removeContainer(existing.container_id)
            }

            await this.docker.restoreVolume(volumeName(payload.agent_id), payload.download_url)

            // Leave it STOPPED — the operator starts it back (a /start spawns a
            // fresh container on the restored volume, --resume continues).
            this.status.push({
                agent_id: payload.agent_id,
                status: 'STOPPED',
                container_id: null,
                last_action: 'restored from backup — start the agent to resume',
            })
            log.info('agent:restore complete (agent left STOPPED)')
            return { ok: true, request_id: payload.request_id }
        } catch (err) {
            log.error({ err: errMessage(err) }, 'agent:restore failed')
            this.status.push({
                agent_id: payload.agent_id,
                status: 'ERROR',
                container_id: null,
                last_action: `restore failed: ${errMessage(err)}`,
            })
            return {
                ok: false,
                request_id: payload.request_id,
                error: {
                    code: 'INTERNAL_ERROR',
                    message: `restore failed: ${errMessage(err)}`,
                    retryable: false,
                },
            }
        }
    }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
