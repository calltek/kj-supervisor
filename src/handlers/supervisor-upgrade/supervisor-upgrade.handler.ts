/**
 * Handler for `supervisor:upgrade-required`. Performs a blue/green
 * swap of the supervisor's own container:
 *
 *   1. Pull the target image.
 *   2. Clone our own container spec (same binds, env, network) but
 *      pointing at the new image. New container boots and starts its
 *      own handshake.
 *   3. Wait GRACE_MS so the new instance has time to claim the
 *      OnlineSupervisorTracker slot for this server. (The control
 *      already does "last writer wins" — the newer connection
 *      replaces ours in the tracker.)
 *   4. exit(0) so Docker's RestartPolicy doesn't relaunch the old one.
 *
 * Pre-conditions:
 *   - KJ_SUPERVISOR_CONTAINER and KJ_SUPERVISOR_IMAGE env vars must be
 *     set (only inside Docker). Without them the handler refuses to
 *     act — bare `bun src/main.ts` in dev should not self-upgrade.
 *
 * The handler never throws to the caller (the event is a push, not
 * a command — no ack expected). All errors are logged and the old
 * supervisor keeps running so the operator can investigate.
 */

import type { KJDocker } from '../../docker/client/client'
import type { KJLogger } from '../../logger'
import type { SupervisorUpgradeRequiredPayload } from '../../protocol'

export interface SupervisorUpgradeHandlerDeps {
    docker: KJDocker
    logger: KJLogger
    /** Container name of the running supervisor (env). */
    supervisor_container: string | null
}

export class SupervisorUpgradeHandler {
    private readonly docker: KJDocker
    private readonly logger: KJLogger
    private readonly supervisor_container: string | null

    private in_progress = false

    constructor(deps: SupervisorUpgradeHandlerDeps) {
        this.docker = deps.docker
        this.logger = deps.logger.child({ component: 'supervisor-upgrade' })
        this.supervisor_container = deps.supervisor_container
    }

    async handle(payload: SupervisorUpgradeRequiredPayload): Promise<void> {
        if (this.in_progress) {
            this.logger.warn('upgrade already in progress; ignoring duplicate event')
            return
        }
        this.in_progress = true

        const log = this.logger.child({
            target_image_tag: payload.target_image_tag,
            reason: payload.reason,
        })
        log.info('supervisor:upgrade-required received')

        if (!this.supervisor_container) {
            log.error(
                'KJ_SUPERVISOR_CONTAINER not set — refusing to self-upgrade. ' +
                    'Operator should restart manually with the new image.'
            )
            this.in_progress = false
            return
        }

        // 1. Pull
        try {
            await this.docker.pullImage(payload.target_image_tag)
        } catch (err) {
            log.error(
                { err: errMessage(err) },
                'pull failed; staying on current version, operator must intervene'
            )
            this.in_progress = false
            return
        }

        // 2. Clone our spec with the new image. Use a temporary name so
        //    we don't collide with the existing container.
        const new_name = `${this.supervisor_container}-new-${Date.now()}`
        let new_container_id: string
        try {
            new_container_id = await this.docker.cloneContainerWithNewImage({
                source_container: this.supervisor_container,
                new_image_tag: payload.target_image_tag,
                new_name,
            })
        } catch (err) {
            log.error({ err: errMessage(err) }, 'failed to start new supervisor; aborting upgrade')
            this.in_progress = false
            return
        }

        log.info(
            { new_container_id },
            'new supervisor started — it will remove us + take the canonical name once it handshakes'
        )

        // 3. We DON'T exit. The fresh clone, once it handshakes, force-removes
        //    THIS container (overriding the restart policy — `exit(0)` does
        //    NOT, `unless-stopped` relaunches a self-exited container → two
        //    supervisors, the old fork-bomb shape) and renames itself to the
        //    canonical name. We keep serving in the meantime, so there's no
        //    "supervisor offline" gap that would flip agents to ERROR. If the
        //    clone fails to boot, we just keep running — safe, recoverable.
        //    `in_progress` stays true so a duplicate event doesn't re-clone.
    }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
