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
import type { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'

export interface AgentBackupHandlerDeps {
    docker: KJDocker
    status: AgentStatusReporter
    logger: KJLogger
}

const volumeName = (agent_id: number): string => `kj-agent-${agent_id}-home`

export class AgentBackupHandler {
    private readonly docker: KJDocker
    private readonly status: AgentStatusReporter
    private readonly logger: KJLogger

    constructor(deps: AgentBackupHandlerDeps) {
        this.docker = deps.docker
        this.status = deps.status
        this.logger = deps.logger.child({ component: 'agent-backup' })
    }

    async handleBackup(payload: AgentBackupPayload): Promise<AgentBackupAck> {
        const log = this.logger.child({
            request_id: payload.request_id,
            agent_id: payload.agent_id,
        })
        log.info('agent:backup received')
        try {
            const { size_bytes } = await this.docker.backupVolume(
                volumeName(payload.agent_id),
                payload.upload_url
            )
            log.info({ size_bytes }, 'agent:backup uploaded')
            return { ok: true, request_id: payload.request_id, size_bytes }
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
