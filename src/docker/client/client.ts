/**
 * Thin wrapper around dockerode tailored to what the supervisor needs.
 * Keeps the surface small (pull, run, inspect, list, remove) so the
 * rest of the code never imports dockerode directly — easier to mock
 * in tests and easier to swap implementation later.
 */

import net from 'node:net'
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
    /**
     * Named docker volume to mount at /home/agent for this container.
     * Persists the agent's home (claude transcripts under .claude/,
     * memories, skills) across stop+start. Created on demand if missing.
     */
    home_volume_name?: string
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
     * Returns true when the daemon already has a local image with the
     * given tag. Used by the spawn handler to skip the pull entirely
     * when the image is cached — important for development (where the
     * tag may not exist in the remote registry at all) and a nice-to-
     * have in production (saves the registry round-trip on every
     * spawn after the first).
     */
    async imageExistsLocally(image_tag: string): Promise<boolean> {
        try {
            await this.docker.getImage(image_tag).inspect()
            return true
        } catch (err) {
            // dockerode throws on 404 with `statusCode: 404`. Any
            // other error (daemon down, permissions) we re-treat as
            // "not local" — the caller will then attempt a pull,
            // which surfaces the same underlying problem with better
            // error text.
            const status = (err as { statusCode?: number }).statusCode
            if (status === 404) return false
            return false
        }
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
     *
     * The container is created with stdin open and stdout/stderr ready
     * to attach: agents talk stream-json over stdio, so the supervisor
     * uses `attachContainer` to read the JSON output and write user
     * messages. `Tty:false` keeps stdout/stderr multiplexed; the
     * caller passes the duplex through `docker.modem.demuxStream`.
     */
    async runContainer(opts: KJContainerRunOptions): Promise<string> {
        const envArray = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)

        // Persistent /home/agent volume. Docker creates the named volume
        // on first use if it doesn't exist, so we don't need a separate
        // create step. The mount survives stop+start; only `agent:delete`
        // removes it (see `removeHomeVolume`).
        const mounts = opts.home_volume_name
            ? [
                  {
                      Type: 'volume' as const,
                      Source: opts.home_volume_name,
                      Target: '/home/agent',
                  },
              ]
            : undefined

        const container = await this.docker.createContainer({
            Image: opts.image_tag,
            name: opts.name,
            Env: envArray,
            Cmd: opts.cmd,
            Labels: opts.labels,
            Tty: false,
            OpenStdin: true,
            StdinOnce: false,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
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
                Mounts: mounts,
            },
        })

        await container.start()
        this.logger.info(
            { container_id: container.id, name: opts.name, image_tag: opts.image_tag },
            'container started'
        )
        return container.id
    }

    /**
     * Attach to a running container's stdio. Returns the raw duplex
     * stream from the docker daemon; the caller is responsible for
     * demultiplexing stdout/stderr (the streams are interleaved with
     * an 8-byte frame header when `Tty:false`) using
     * `demuxAttachStream` below.
     */
    /**
     * Attach to a container's stdio over the docker UNIX socket.
     *
     * We bypass dockerode here because Bun's `http.request` does not
     * emit `'upgrade'` events reliably (the same call works under Node
     * but hangs under Bun), and dockerode's attach relies on that
     * event. Going straight to the socket with `net.connect` works on
     * both runtimes and gives us the same multiplexed duplex (8-byte
     * frame header for stdout/stderr) that `demuxAttachStream` already
     * knows how to unpack.
     */
    async attachContainer(container_id: string): Promise<NodeJS.ReadWriteStream> {
        const socketPath = '/var/run/docker.sock'
        const path = `/containers/${container_id}/attach?stream=1&stdin=1&stdout=1&stderr=1`
        const request =
            `POST ${path} HTTP/1.1\r\n` +
            `Host: localhost\r\n` +
            `Connection: Upgrade\r\n` +
            `Upgrade: tcp\r\n` +
            `Content-Type: application/vnd.docker.raw-stream\r\n` +
            `Content-Length: 0\r\n` +
            `\r\n`

        return new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
            const sock = net.connect(socketPath)
            let header_buffer = ''
            let upgraded = false

            const timer = setTimeout(() => {
                if (upgraded) return
                sock.destroy(new Error('docker attach timed out after 10s'))
            }, 10_000)

            sock.once('error', (err) => {
                clearTimeout(timer)
                if (!upgraded) reject(err)
            })

            const onHeader = (chunk: Buffer): void => {
                header_buffer += chunk.toString('utf8')
                const end = header_buffer.indexOf('\r\n\r\n')
                if (end < 0) return // need more bytes
                const head = header_buffer.slice(0, end)
                const remainder = Buffer.from(
                    header_buffer.slice(end + 4),
                    'binary' as BufferEncoding
                )

                const status_line = head.split('\r\n')[0] ?? ''
                if (!status_line.includes('101')) {
                    clearTimeout(timer)
                    sock.destroy()
                    reject(new Error(`docker attach refused: ${status_line || '<no status>'}`))
                    return
                }

                upgraded = true
                clearTimeout(timer)
                sock.off('data', onHeader)
                // Any payload that arrived in the same TCP segment as
                // the HTTP headers must be replayed into the duplex.
                if (remainder.length > 0) sock.unshift(remainder)
                resolve(sock)
            }

            sock.on('data', onHeader)
            sock.write(request)
        })
    }

    /**
     * Demultiplex a docker attach stream into stdout/stderr writable
     * sinks. When the container runs without TTY, docker frames every
     * payload with an 8-byte header that says which stream the bytes
     * came from; `dockerode`'s modem knows how to unpack it.
     */
    demuxAttachStream(
        stream: NodeJS.ReadableStream,
        stdout: NodeJS.WritableStream,
        stderr: NodeJS.WritableStream
    ): void {
        this.docker.modem.demuxStream(stream, stdout, stderr)
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
     * Recreate a container under the SAME name, reusing the source's
     * env / labels / mounts / network but with whatever image the
     * caller passes. The previous container is stopped + removed first
     * (so the name is free for the new one). Used by the image-update
     * handler to "swap in" a freshly-pulled image without leaking the
     * env vars set by the original spawn payload.
     *
     * Unlike `cloneContainerWithNewImage`, this keeps the container
     * name stable, which matters for callers that look up by name.
     */
    async recreateContainerWithImage(opts: {
        source_container: string
        new_image_tag: string
        keep_name: string
        force_stop?: boolean
    }): Promise<string> {
        this.logger.info(
            {
                source: opts.source_container,
                image: opts.new_image_tag,
                name: opts.keep_name,
            },
            'recreating container with image'
        )

        const source = await this.docker.getContainer(opts.source_container).inspect()
        const config = source.Config
        const host = source.HostConfig

        // Stop + remove old first; the name has to be free before we
        // can reuse it. Force is on by default — the operator already
        // accepted the downtime by clicking the button.
        await this.stopContainer(opts.source_container, { force: opts.force_stop ?? true })
        await this.removeContainer(opts.source_container)

        const created = await this.docker.createContainer({
            Image: opts.new_image_tag,
            name: opts.keep_name,
            Env: config.Env,
            Cmd: config.Cmd ?? undefined,
            Entrypoint: config.Entrypoint ?? undefined,
            Labels: config.Labels,
            // Mirror what runContainer sets when spawning fresh agents:
            // the wrapper reads operator messages from process.stdin
            // and writes claude's stream-json on stdout, so the new
            // container MUST have stdin open + stdio attachable.
            // Dropped silently before, which left the wrapper polling
            // a stdin that never produced lines — heartbeats fine,
            // input dead.
            Tty: false,
            OpenStdin: true,
            StdinOnce: false,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                Binds: host.Binds,
                Mounts: host.Mounts,
                RestartPolicy: host.RestartPolicy,
                NetworkMode: host.NetworkMode,
                GroupAdd: host.GroupAdd,
            },
        })

        await created.start()
        this.logger.info({ new_container_id: created.id }, 'recreate started')
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

    /**
     * Remove a docker named volume. Called when the control deletes
     * an agent — without this, every deleted agent leaves a dangling
     * named volume behind. Silent on "no such volume" / "in use" so
     * the caller doesn't have to special-case.
     */
    async removeVolume(name: string): Promise<void> {
        await this.docker
            .getVolume(name)
            .remove()
            .catch(() => undefined)
    }

    /**
     * Seed a named volume with arbitrary files BEFORE the agent
     * container starts. The supervisor uses this for SHORT_TERM
     * memories: each entry is written under /home/agent/.claude/
     * memories/ inside the volume so the agent finds them on first
     * boot of the next spawn.
     *
     * Implementation: spawn a short-lived `alpine:3.20` helper that
     * mounts the volume at /v and runs a tiny script. We pull the
     * helper image once and reuse it; Alpine is ~5MB, negligible.
     * The helper exits as soon as it's done writing — no long-lived
     * sidecar.
     *
     * `files` is keyed by path relative to the mount point. Existing
     * files at the same path are overwritten; nothing else in the
     * volume is touched. `readonly` is honoured by chmod 0444; the
     * directory containing the files stays writable so future seeds
     * (e.g. a content update) can overwrite.
     */
    async seedVolumeFiles(opts: {
        volume_name: string
        target_dir: string // relative to /v, e.g. ".claude/memories"
        files: Array<{ path: string; content: string; readonly?: boolean }>
        /**
         * When true, wipe the contents of `target_dir` before writing.
         * Used by the spawn handler for `.claude/memories/` so files
         * that were renamed or unassigned in BD don't survive as
         * orphans in the volume. We delete the *contents*, not the
         * directory itself, so its UID/permissions are preserved.
         */
        purge?: boolean
    }): Promise<void> {
        if (opts.files.length === 0 && !opts.purge) return

        const helperImage = 'alpine:3.20'

        // Make sure the helper image is available locally. cheaper than
        // pulling every call (alpine layers are cached after the first).
        const cached = await this.imageExistsLocally(helperImage)
        if (!cached) {
            await this.pullImage(helperImage, () => {})
        }

        // Encode each file as a heredoc the shell can run safely. Use
        // base64 to avoid having to escape arbitrary markdown content
        // (backticks, $, EOF markers, …) inside the heredoc.
        const targetDir = opts.target_dir.replace(/^\/+/, '').replace(/\/+$/, '')
        const lines: string[] = ['set -e', `mkdir -p "/v/${targetDir}"`]
        if (opts.purge) {
            // Wipe contents (recursive) but keep the directory itself
            // so its existing ownership/permissions stay intact.
            // `find` is more portable than `rm -rf glob` for hidden
            // files and avoids the "argument list too long" trap.
            lines.push(`find "/v/${targetDir}" -mindepth 1 -delete`)
        }
        for (const f of opts.files) {
            // The path may contain `/` for S3-style folder nesting
            // (memory names like `comercial/oferta.md`). `mkdir -p`
            // on every parent before writing keeps the helper simple
            // and idempotent — Alpine's mkdir handles the no-op case.
            const safeName = f.path.replace(/^\/+/, '')
            const parent = safeName.includes('/')
                ? safeName.slice(0, safeName.lastIndexOf('/'))
                : ''
            if (parent) {
                lines.push(`mkdir -p "/v/${targetDir}/${parent}"`)
            }
            const b64 = Buffer.from(f.content, 'utf8').toString('base64')
            // Remove first: previous seeds may have left the file as
            // 0444 (readonly), which would make the next write fail
            // with EACCES. `rm -f` no-ops when the file doesn't exist.
            lines.push(`rm -f "/v/${targetDir}/${safeName}"`)
            lines.push(`echo "${b64}" | base64 -d > "/v/${targetDir}/${safeName}"`)
            if (f.readonly) {
                lines.push(`chmod 0444 "/v/${targetDir}/${safeName}"`)
            }
        }
        const script = lines.join('\n')

        const container = await this.docker.createContainer({
            Image: helperImage,
            // No labels — these are throwaway, the reconcile must NOT
            // ever pick them up as agent containers.
            Cmd: ['sh', '-c', script],
            HostConfig: {
                // AutoRemove false: we want to inspect the logs on
                // failure. We remove the container explicitly after
                // wait().
                AutoRemove: false,
                Mounts: [
                    {
                        Type: 'volume',
                        Source: opts.volume_name,
                        Target: '/v',
                    },
                ],
                // The agent's volume is owned by the agent user (UID
                // 1000) on every directory it touches. The helper
                // runs as root but the default CapDrop:ALL also
                // removes CAP_DAC_OVERRIDE, which root needs to write
                // into a directory it doesn't own. Keep that single
                // capability so the helper can drop files anywhere
                // inside /v while still being heavily sandboxed.
                CapDrop: ['ALL'],
                CapAdd: ['DAC_OVERRIDE'],
                SecurityOpt: ['no-new-privileges'],
            },
        })
        await container.start()
        // wait() resolves with StatusCode when the container exits.
        const result = await container.wait()
        if (result.StatusCode !== 0) {
            // Pull stdout+stderr before removing so the operator can
            // see WHY the helper failed instead of a bare exit code.
            let logsTxt = ''
            try {
                const logsBuf = await container.logs({
                    stdout: true,
                    stderr: true,
                    follow: false,
                })
                logsTxt = Buffer.isBuffer(logsBuf) ? logsBuf.toString('utf8') : String(logsBuf)
                // dockerode returns multiplexed frames when Tty:false.
                // The 8-byte header per frame can leak into the string;
                // we strip it on a best-effort basis.
                // dockerode returns multiplexed frames when Tty:false.
                // The 8-byte header per frame can leak into the string;
                // we strip non-printable bytes (keep tab/lf and >= 0x20).
                logsTxt = logsTxt
                    .split('')
                    .filter((c) => {
                        const code = c.charCodeAt(0)
                        return code === 9 || code === 10 || code >= 32
                    })
                    .join('')
                    .trim()
            } catch {
                // ignore — we still throw with what we have.
            }
            await container.remove({ force: true }).catch(() => undefined)
            throw new Error(
                `seedVolumeFiles helper exited with code ${result.StatusCode} for volume ${opts.volume_name}: ${
                    logsTxt || '(no logs captured)'
                }`
            )
        }
        await container.remove({ force: true }).catch(() => undefined)
        this.logger.info(
            {
                volume: opts.volume_name,
                target_dir: targetDir,
                file_count: opts.files.length,
            },
            'seeded volume files'
        )
    }
}
