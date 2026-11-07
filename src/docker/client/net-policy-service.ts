/**
 * Where an agent's network policy (net-policy.ts) is put in force: after its
 * container starts (spawn, recreate by image), when this supervisor re-attaches
 * to it (`agent:sync`), and when the control changes it on a running agent.
 *
 * Whether the rules are a PROMISE depends on what they protect:
 *  - a list someone configured, or any agent on a shared machine (the floor is
 *    what keeps one tenant from another): if they can't be written, the agent
 *    is stopped rather than left running without them;
 *  - a dedicated machine with no list: there is nothing to write for the
 *    conversations (they stay open, as before lists existed), so the helper
 *    doesn't even run. The browser writes its own when it starts.
 */
import type { KJLogger } from '../../logger'
import type { KJDocker } from './client'
import { isCustomNetPolicy } from './net-policy'

export type NetPolicyDocker = Pick<
    KJDocker,
    'setNetPolicy' | 'netPolicyOf' | 'applyNetPolicy' | 'stopContainer' | 'isShared'
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
     * container's namespace when there is something to write.
     */
    async enforce(agent_id: number, container_id: string, raw?: unknown): Promise<EnforceResult> {
        const policy =
            raw === undefined
                ? this.docker.netPolicyOf(agent_id)
                : this.docker.setNetPolicy(agent_id, raw)
        const shared = this.docker.isShared()
        const custom = isCustomNetPolicy(policy)
        if (!shared && !custom) return { ok: true }
        try {
            await this.docker.applyNetPolicy(container_id)
            return { ok: true }
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            this.logger.error(
                { agent_id, container_id, err: error, custom, shared },
                'network policy could not be applied — stopping the agent'
            )
            await this.docker.stopContainer(container_id, { force: true }).catch(() => undefined)
            return { ok: false, error, stopped: true }
        }
    }
}
