/**
 * Where an agent's network policy (net-policy.ts) is put in force: after its
 * container starts (spawn, recreate by image), when this supervisor re-attaches
 * to it (`agent:sync`), and when the control changes it on a running agent.
 *
 * A policy someone configured is a promise to them: if it can't be written,
 * the agent is stopped rather than left running without it. The default one
 * (no lists) only adds the floor; failing to write it is logged and the agent
 * keeps running, as it did before there were lists — the floor can't take a
 * fleet down on a host where the helper doesn't work.
 */
import type { KJLogger } from '../../logger'
import type { KJDocker } from './client'
import { isCustomNetPolicy } from './net-policy'

export type NetPolicyDocker = Pick<
    KJDocker,
    'setNetPolicy' | 'netPolicyOf' | 'applyNetPolicy' | 'stopContainer'
>

export type EnforceResult = { ok: true } | { ok: false; error: string; stopped: boolean }

export class NetPolicyService {
    private readonly logger: KJLogger

    constructor(
        private readonly docker: NetPolicyDocker,
        logger: KJLogger
    ) {
        this.logger = logger.child({ component: 'net-policy' })
    }

    /**
     * Remember `raw` (when the control sent one: an older control sends
     * nothing, and the last known policy stands) and write it into the
     * container's namespace.
     */
    async enforce(agent_id: number, container_id: string, raw?: unknown): Promise<EnforceResult> {
        const policy =
            raw === undefined
                ? this.docker.netPolicyOf(agent_id)
                : this.docker.setNetPolicy(agent_id, raw)
        try {
            await this.docker.applyNetPolicy(container_id)
            return { ok: true }
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            const custom = isCustomNetPolicy(policy)
            this.logger.error(
                { agent_id, container_id, err: error, custom },
                custom
                    ? 'network policy could not be applied — stopping the agent'
                    : 'network floor could not be applied — the agent keeps its old network'
            )
            if (!custom) return { ok: false, error, stopped: false }
            await this.docker.stopContainer(container_id, { force: true }).catch(() => undefined)
            return { ok: false, error, stopped: true }
        }
    }
}
