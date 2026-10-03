/**
 * Push `agent:image:report`: which build an agent's container runs.
 *
 * The catalogue tag (`kj-agent-base:latest`, `kj-agent-flex:0.2.0`) is
 * reused by every build, so the control can't tell from it whether a fleet
 * rollout reached an agent. The image's OCI labels can: CI stamps
 * `org.opencontainers.image.revision` (the commit) and `.created` on every
 * build. We read them from the IMAGE the container was created from, not
 * from the container's own labels: a recreate copies the old container's
 * labels across, so those would keep the previous build's commit.
 *
 * Fire-and-forget like `agent:status`. Reported once per container: a
 * repeated RUNNING (unpause, a heartbeat) for the same container costs
 * nothing. A supervisor restart forgets that and reports again on the
 * `agent:sync` re-attach, which is how agents that were already running
 * when this shipped get theirs.
 */

import type { KJLogger } from '../../logger'
import type { AgentImageReport } from '../../protocol'

const REVISION_LABEL = 'org.opencontainers.image.revision'
const CREATED_LABEL = 'org.opencontainers.image.created'

export interface ImageReportClient {
    push(event: string, payload: unknown): void
}

/** The two docker reads this needs, so tests can fake them. */
export interface ImageInspector {
    inspect(container_id: string): Promise<{ Image?: string }>
    inspectImage(image: string): Promise<{
        Created?: string
        Config?: { Labels?: Record<string, string> | null } | null
    }>
}

export class AgentImageReporter {
    private readonly client: ImageReportClient
    private readonly docker: ImageInspector
    private readonly logger: KJLogger
    /** agent_id → the container we last reported for it. */
    private readonly reported = new Map<number, string>()

    constructor(client: ImageReportClient, docker: ImageInspector, logger: KJLogger) {
        this.client = client
        this.docker = docker
        this.logger = logger.child({ component: 'agent-image' })
    }

    /** Never throws and never blocks the caller: the read runs behind. */
    report(agent_id: number, container_id: string): void {
        if (this.reported.get(agent_id) === container_id) return
        this.reported.set(agent_id, container_id)
        void this.read(container_id)
            .then((build) => {
                const payload: AgentImageReport = { agent_id, container_id, ...build }
                this.client.push('agent:image:report', payload)
            })
            .catch((err) => {
                // Let the next RUNNING try again instead of remembering a miss.
                if (this.reported.get(agent_id) === container_id) this.reported.delete(agent_id)
                this.logger.debug(
                    {
                        agent_id,
                        container_id,
                        err: err instanceof Error ? err.message : String(err),
                    },
                    'could not read the image build of the container'
                )
            })
    }

    private async read(
        container_id: string
    ): Promise<Pick<AgentImageReport, 'revision' | 'built_at'>> {
        const container = await this.docker.inspect(container_id)
        if (!container.Image) throw new Error('container has no image id')
        const image = await this.docker.inspectImage(container.Image)
        const labels = image.Config?.Labels ?? {}
        return {
            revision: labels[REVISION_LABEL] || null,
            built_at: labels[CREATED_LABEL] || image.Created || null,
        }
    }
}
