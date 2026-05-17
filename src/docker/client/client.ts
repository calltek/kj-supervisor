/**
 * Thin wrapper around dockerode tailored to what the supervisor needs.
 * Keeps the surface small (pull, run, inspect, list, remove) so the
 * rest of the code never imports dockerode directly — easier to mock
 * in tests and easier to swap implementation later.
 */

import Docker from 'dockerode'

import type { KJLogger } from '../../logger'

/** Labels we attach to every container we spawn so we can reconcile later. */
export const KJ_LABEL = 'kj-agent'
export const KJ_LABEL_AGENT_ID = 'kj-agent-id'

export interface KJContainerRunOptions {
    image_tag: string
    name: string
    env: Record<string, string>
    cmd?: string[]
    labels: Record<string, string>
    resources: { memory_mb: number; cpu: number }
}

export interface KJContainerSummary {
    container_id: string
    agent_id: number | null
}

/** Shape of each pull progress event Docker emits per layer. */
export interface PullProgressEvent {
    status: string
    id?: string
    progressDetail?: { current?: number; total?: number }
    progress?: string
}

/**
 * Shape of a Docker daemon event (the subset we care about). Docker's
 * stream emits a JSON line per event with many more fields; we type
 * only what the watcher reads.
 */
export interface DockerEvent {
    Type: string // 'container', 'image', 'network'...
    Action: string // 'start', 'die', 'stop', 'kill', 'pause', 'unpause', 'destroy'...
    Actor: {
        ID: string // container id
        Attributes?: Record<string, string> // labels + extras
    }
    time?: number
    timeNano?: number
}

export class KJDocker {
    private readonly docker: Docker
    private readonly logger: KJLogger

    constructor(logger: KJLogger, docker?: Docker) {
        this.logger = logger.child({ component: 'docker' })
        this.docker = docker ?? new Docker()
    }

    /**
     * Pull an image from the registry. Resolves when the daemon has the
     * image; rejects on pull failure (network, auth, missing tag).
     *
     * `onProgress` is invoked on every layer event (downloading,
     * extracting...) so the caller can surface granular progress to
     * the control. The callback must not throw.
     *
     * `auth` is forwarded to the docker daemon as the registry
     * credentials for THIS pull. Use it for private images. Never log
     * its contents — `dockerode` already does the right thing here.
     */
    async pullImage(
        image_tag: string,
        onProgress?: (event: PullProgressEvent) => void,
        auth?: { username: string; password: string; serveraddress?: string }
    ): Promise<void> {
        this.logger.info({ image_tag, authenticated: Boolean(auth) }, 'pulling image')
        // dockerode forwards `authconfig` to the daemon as the X-Registry-Auth
        // header, which is what `docker login + docker pull` does under the hood.
        const pullOptions: Record<string, unknown> = {}
        if (auth) {
            pullOptions.authconfig = {
                username: auth.username,
                password: auth.password,
                serveraddress: auth.serveraddress,
            }
        }
        const stream = await this.docker.pull(image_tag, pullOptions)
        await new Promise<void>((resolve, reject) => {
            this.docker.modem.followProgress(
                stream,
                (err) => (err ? reject(err) : resolve()),
                (event: PullProgressEvent) => {
                    if (onProgress) onProgress(event)
                }
            )
        })
        this.logger.info({ image_tag }, 'image pulled')
    }

    /**
     * Create + start a container. Returns its id. The caller is
     * responsible for any post-start verification (inspect, status push).
     */
    async runContainer(opts: KJContainerRunOptions): Promise<string> {
        const envArray = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)

        const container = await this.docker.createContainer({
            Image: opts.image_tag,
            name: opts.name,
            Env: envArray,
            Cmd: opts.cmd,
            Labels: opts.labels,
            HostConfig: {
                // Resource limits
                Memory: opts.resources.memory_mb * 1024 * 1024,
                NanoCpus: Math.round(opts.resources.cpu * 1_000_000_000),
                // Security defaults: drop everything, no privilege escalation.
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges'],
                // Restart so the container survives docker daemon restarts but
                // not its own crashes (the supervisor decides whether to relaunch).
                RestartPolicy: { Name: 'unless-stopped' },
            },
        })

        await container.start()
        this.logger.info(
            { container_id: container.id, name: opts.name, image_tag: opts.image_tag },
            'container started'
        )
        return container.id
    }

    /** Get a container's basic state (running, exitCode, etc.). */
    async inspect(container_id: string): Promise<Docker.ContainerInspectInfo> {
        return this.docker.getContainer(container_id).inspect()
    }

    /**
     * Re-create a container preserving its mounts, env, command,
     * labels, and network mode, but pointing at a different image
     * tag. Used for the supervisor's own blue/green self-upgrade.
     *
     * The new container starts running immediately. The caller is
     * responsible for the old one's shutdown.
     */
    async cloneContainerWithNewImage(opts: {
        source_container: string
        new_image_tag: string
        new_name: string
    }): Promise<string> {
        this.logger.info(
            {
                source: opts.source_container,
                image: opts.new_image_tag,
                name: opts.new_name,
            },
            'cloning container with new image'
        )

        const source = await this.docker.getContainer(opts.source_container).inspect()

        const created = await this.docker.createContainer({
            Image: opts.new_image_tag,
            name: opts.new_name,
            Env: source.Config.Env,
            Cmd: source.Config.Cmd ?? undefined,
            Entrypoint: source.Config.Entrypoint ?? undefined,
            Labels: source.Config.Labels,
            HostConfig: {
                Binds: source.HostConfig.Binds,
                Mounts: source.HostConfig.Mounts,
                RestartPolicy: source.HostConfig.RestartPolicy,
                NetworkMode: source.HostConfig.NetworkMode,
                GroupAdd: source.HostConfig.GroupAdd,
            },
        })

        await created.start()
        this.logger.info({ new_container_id: created.id }, 'clone started')
        return created.id
    }

    /**
     * List every container labeled with kj-agent. Used by reconciliation
     * at server:hello time.
     */
    async listKjContainers(): Promise<KJContainerSummary[]> {
        const containers = await this.docker.listContainers({
            all: true,
            filters: { label: [KJ_LABEL] },
        })
        return containers.map((c) => {
            const agent_id_raw = c.Labels?.[KJ_LABEL_AGENT_ID]
            const agent_id = agent_id_raw ? Number.parseInt(agent_id_raw, 10) : null
            return {
                container_id: c.Id,
                agent_id: Number.isFinite(agent_id) ? agent_id : null,
            }
        })
    }

    /** Stop (SIGTERM, grace 10s, then SIGKILL) or force kill a container. */
    async stopContainer(container_id: string, opts: { force?: boolean } = {}): Promise<void> {
        const container = this.docker.getContainer(container_id)
        if (opts.force) {
            this.logger.warn({ container_id }, 'killing container (SIGKILL)')
            await container.kill().catch(() => undefined)
        } else {
            this.logger.info({ container_id }, 'stopping container (SIGTERM, 10s grace)')
            await container.stop({ t: 10 }).catch(() => undefined)
        }
    }

    /** Freeze a running container (SIGSTOP via cgroups). */
    async pauseContainer(container_id: string): Promise<void> {
        this.logger.info({ container_id }, 'pausing container')
        await this.docker.getContainer(container_id).pause()
    }

    /** Thaw a paused container. */
    async unpauseContainer(container_id: string): Promise<void> {
        this.logger.info({ container_id }, 'unpausing container')
        await this.docker.getContainer(container_id).unpause()
    }

    /**
     * Subscribe to the docker daemon events stream, filtered to events
     * touching kj-agent-labeled containers. Returns a readable stream
     * of newline-delimited JSON; the caller parses each line into a
     * DockerEvent.
     */
    async getEvents(): Promise<NodeJS.ReadableStream> {
        const stream = await this.docker.getEvents({
            filters: {
                type: ['container'],
                label: [KJ_LABEL],
            },
        })
        return stream as NodeJS.ReadableStream
    }

    /** Remove a stopped container. Safe to call after stop. */
    async removeContainer(container_id: string): Promise<void> {
        await this.docker
            .getContainer(container_id)
            .remove({ force: true })
            .catch(() => undefined)
    }
}
