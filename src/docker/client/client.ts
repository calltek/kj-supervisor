/**
 * Thin wrapper around dockerode tailored to what the supervisor needs.
 * Keeps the surface small (pull, run, inspect, list, remove) so the
 * rest of the code never imports dockerode directly — easier to mock
 * in tests and easier to swap implementation later.
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import Docker from 'dockerode'

import type { KJLogger } from '../../logger'

/**
 * Our own container id, read from /proc — works under `--network host` where
 * os.hostname() is the HOST name, not the container id (incident 2026-06-24).
 * cgroup v1 puts `/docker/<id>` in /proc/self/cgroup; cgroup v2 puts the id in
 * the bind-mount paths of /proc/self/mountinfo (…/containers/<id>/hostname).
 * Returns the 64-hex id or null (e.g. running outside Docker in dev).
 */
function readOwnContainerId(): string | null {
    const re = /\b[0-9a-f]{64}\b/
    for (const path of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
        try {
            const m = fs.readFileSync(path, 'utf8').match(re)
            if (m) return m[0]
        } catch {
            /* not on Linux / no procfs — try the next, then give up */
        }
    }
    return null
}

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
     * Attach to a container's STDIN only, returning the writable socket.
     * Used by `seedVolumeFiles` to feed a large `sh -s` script over the
     * stream instead of through Cmd (which would hit ARG_MAX). Same raw
     * socket-upgrade dance as `attachContainer`, but stdin-only — we
     * don't read the helper's output here (the caller pulls logs via
     * `container.logs()` after it exits).
     */
    async attachContainerStdin(container_id: string): Promise<NodeJS.WritableStream> {
        const socketPath = '/var/run/docker.sock'
        const path = `/containers/${container_id}/attach?stream=1&stdin=1`
        const request =
            `POST ${path} HTTP/1.1\r\n` +
            `Host: localhost\r\n` +
            `Connection: Upgrade\r\n` +
            `Upgrade: tcp\r\n` +
            `Content-Type: application/vnd.docker.raw-stream\r\n` +
            `Content-Length: 0\r\n` +
            `\r\n`

        return new Promise<NodeJS.WritableStream>((resolve, reject) => {
            const sock = net.connect(socketPath)
            let header_buffer = ''
            let upgraded = false

            const timer = setTimeout(() => {
                if (upgraded) return
                sock.destroy(new Error('docker stdin attach timed out after 10s'))
            }, 10_000)

            sock.once('error', (err) => {
                clearTimeout(timer)
                if (!upgraded) reject(err)
            })

            const onHeader = (chunk: Buffer): void => {
                header_buffer += chunk.toString('utf8')
                const end = header_buffer.indexOf('\r\n\r\n')
                if (end < 0) return
                const status_line = header_buffer.slice(0, end).split('\r\n')[0] ?? ''
                if (!status_line.includes('101')) {
                    clearTimeout(timer)
                    sock.destroy()
                    reject(
                        new Error(`docker stdin attach refused: ${status_line || '<no status>'}`)
                    )
                    return
                }
                upgraded = true
                clearTimeout(timer)
                sock.off('data', onHeader)
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
     * Run a one-shot command inside a container (`docker exec`) and return its
     * merged stdout/stderr + exit code. Runs as `/bin/sh -c "<command>"` so a
     * full shell line works. Captures up to `maxOutputBytes` and truncates the
     * rest. Kills the exec and resolves `timedOut: true` past `timeout_ms`.
     */
    async exec(opts: {
        container_id: string
        command: string
        timeout_ms: number
        maxOutputBytes?: number
    }): Promise<{ exit_code: number; output: string; truncated: boolean; timedOut: boolean }> {
        const maxBytes = opts.maxOutputBytes ?? 64 * 1024
        const container = this.docker.getContainer(opts.container_id)
        const exec = await container.exec({
            Cmd: ['/bin/sh', '-c', opts.command],
            AttachStdout: true,
            AttachStderr: true,
            // Tty:true merges stdout+stderr into a single RAW stream (no 8-byte
            // multiplex frames), so we read bytes directly — no demux, and no
            // "(HTTP code 101) unexpected" from mishandling the hijacked socket.
            Tty: true,
        })
        const stream = (await exec.start({ Tty: true })) as NodeJS.ReadableStream

        return await new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            let size = 0
            let truncated = false
            let settled = false

            const collect = (): string => Buffer.concat(chunks).toString('utf8')

            const timer = setTimeout(() => {
                if (settled) return
                settled = true
                ;(stream as unknown as { destroy?: () => void }).destroy?.()
                resolve({ exit_code: -1, output: collect(), truncated, timedOut: true })
            }, opts.timeout_ms)

            stream.on('data', (chunk: Buffer) => {
                if (size >= maxBytes) {
                    truncated = true
                    return
                }
                const room = maxBytes - size
                chunks.push(chunk.subarray(0, room))
                if (chunk.length > room) truncated = true
                size += Math.min(chunk.length, room)
            })
            stream.on('end', () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                exec.inspect()
                    .then((info) =>
                        resolve({
                            exit_code: info.ExitCode ?? 0,
                            output: collect(),
                            truncated,
                            timedOut: false,
                        })
                    )
                    .catch(reject)
            })
            stream.on('error', (err: Error) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                reject(err)
            })
        })
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

        // Tell the clone its OWN container name so it can complete the blue/green
        // swap reliably. We can't depend on os.hostname() inside the clone: under
        // `--network host` (the whole Linux fleet) the container hostname is the
        // HOST's name, not the container id, so getContainer(os.hostname()) 404s
        // and the clone wrongly concludes it isn't a clone → never swaps → two
        // supervisors survive (incident 2026-06-24). Strip any stale value
        // inherited from the source (which may itself have been a clone).
        const env = (source.Config.Env ?? []).filter((e) => !e.startsWith('KJ_OWN_CONTAINER='))
        env.push(`KJ_OWN_CONTAINER=${opts.new_name}`)

        const created = await this.docker.createContainer({
            Image: opts.new_image_tag,
            name: opts.new_name,
            Env: env,
            Cmd: source.Config.Cmd ?? undefined,
            Entrypoint: source.Config.Entrypoint ?? undefined,
            Labels: source.Config.Labels,
            HostConfig: {
                Binds: source.HostConfig.Binds,
                Mounts: source.HostConfig.Mounts,
                RestartPolicy: source.HostConfig.RestartPolicy,
                NetworkMode: source.HostConfig.NetworkMode,
                GroupAdd: source.HostConfig.GroupAdd,
                // Preserve the source's resource limits (KUJI-42) — don't
                // silently drop them on the blue/green clone.
                Memory: source.HostConfig.Memory,
                NanoCpus: source.HostConfig.NanoCpus,
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
        // KUJI-42: re-apply the container limits the control sized. Without
        // this the recreate dropped Memory/NanoCpus and left the container
        // unbounded → a runaway tool (Playwright/Chromium) could OOM the host.
        // Falls back to whatever the source container had if absent.
        resources?: { memory_mb: number; cpu: number }
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
                // Re-apply the resource limits (KUJI-42). The control's value
                // wins; otherwise preserve what the source had (never silently
                // leave it unbounded again).
                Memory: opts.resources ? opts.resources.memory_mb * 1024 * 1024 : host.Memory,
                NanoCpus: opts.resources
                    ? Math.round(opts.resources.cpu * 1_000_000_000)
                    : host.NanoCpus,
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
     * Our OWN container name. Docker sets a container's hostname to its short
     * id by default (we never override it), so `os.hostname()` is our id; we
     * inspect it to get the name. Used by the blue/green self-upgrade to tell
     * whether we're the fresh clone (`kj-supervisor-new-*`) that still has to
     * remove the old container + rename itself to the canonical name. Returns
     * null outside Docker (dev) or if the lookup fails.
     */
    async getOwnContainerName(): Promise<string | null> {
        // 1. Preferred: the name the clone was created with, injected as an env
        //    var by cloneContainerWithNewImage (the fast, explicit path).
        const fromEnv = process.env.KJ_OWN_CONTAINER?.trim()
        if (fromEnv) return fromEnv
        // 2. Our own container id from /proc, then inspect it for the name. This
        //    works under `--network host` (the Linux fleet), where os.hostname()
        //    returns the HOST name, not the container id (incident 2026-06-24).
        //    Crucially this makes the swap self-complete even on the FIRST
        //    upgrade to this fix — the clone (new image) is created by the OLD
        //    cloner without the env var, so it must fall back to /proc.
        const ownId = readOwnContainerId()
        if (ownId) {
            try {
                const info = await this.docker.getContainer(ownId).inspect()
                return info.Name.replace(/^\//, '')
            } catch {
                /* fall through */
            }
        }
        // 3. Bridge networking / dev: the container hostname defaults to the
        //    short container id, which inspect resolves to the real name.
        try {
            const info = await this.docker.getContainer(os.hostname()).inspect()
            return info.Name.replace(/^\//, '')
        } catch {
            return null
        }
    }

    /** Rename a container (dockerode `rename`). Used to finish the blue/green swap. */
    async renameContainer(id_or_name: string, new_name: string): Promise<void> {
        await this.docker.getContainer(id_or_name).rename({ name: new_name })
    }

    /**
     * Whether a container with this exact name exists. Used by the blue/green
     * swap to confirm we're still the temp-named clone BEFORE removing the
     * canonical — guards against a stale KJ_OWN_CONTAINER (after a swap+rename,
     * the env still holds the old temp name; on a restart that would otherwise
     * make us force-remove ourselves). Returns false on any lookup error.
     */
    async containerExists(name: string): Promise<boolean> {
        try {
            await this.docker.getContainer(name).inspect()
            return true
        } catch {
            return false
        }
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
    /**
     * Ensure the ROOT of a named volume is owned by UID 1000 (`bun`).
     *
     * A named volume is created root:root the first time it's mounted, which
     * shadows the image's build-time `chown bun:bun /home/agent`. Without
     * this, the agent (UID 1000) can't mkdir /home/agent/conv/<session> at
     * runtime → the session cwd never exists → `claude` fails with ENOENT
     * (posix_spawn) and the agent goes silent. Per-seed chowns only fix the
     * subdirs they touch, not the root, and don't run at all for agents with
     * nothing to seed — so this runs unconditionally at spawn.
     *
     * Non-recursive: it only fixes the root dir's ownership. The seeded
     * subtrees keep their own (the seed helper chowns each targetDir), so we
     * don't disturb the 0444 readonly files.
     */
    async ensureVolumeOwnership(volume_name: string): Promise<void> {
        const helperImage = 'alpine:3.20'
        const cached = await this.imageExistsLocally(helperImage)
        if (!cached) await this.pullImage(helperImage, () => {})

        const container = await this.docker.createContainer({
            Image: helperImage,
            Cmd: ['sh', '-c', 'chown 1000:1000 /v'],
            HostConfig: {
                Binds: [`${volume_name}:/v`],
                AutoRemove: false,
                CapAdd: ['CHOWN'],
            },
        })
        try {
            await container.start()
            const result = await container.wait()
            if (result.StatusCode !== 0) {
                this.logger.warn(
                    { volume_name, code: result.StatusCode },
                    'ensureVolumeOwnership helper exited non-zero (agent may hit EACCES)'
                )
            }
        } finally {
            await container.remove({ force: true }).catch(() => {})
        }
    }

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
        // The helper runs as root, so everything it creates (the target
        // dir tree + the files) ends up root:root. But the agent runs as
        // UID 1000 (`bun`) and must be able to WRITE inside these dirs —
        // e.g. the wrapper's syncBuiltinSkills() copies image skills into
        // .claude/skills/ at boot. Without this chown that fails with
        // EACCES and the base skills/context never land. Chown the whole
        // target tree to 1000:1000 (readonly files keep their 0444 mode —
        // ownership and permission bits are independent).
        lines.push(`chown -R 1000:1000 "/v/${targetDir}"`)
        const script = lines.join('\n')

        const container = await this.docker.createContainer({
            Image: helperImage,
            // No labels — these are throwaway, the reconcile must NOT
            // ever pick them up as agent containers.
            //
            // The script is fed over STDIN (`sh -s`), NOT through Cmd.
            // A spawn payload with many memories/skills encodes each
            // file as inline base64; the whole script can run into
            // hundreds of KB. Passing that as a process argument hits
            // the kernel's ARG_MAX and exec fails with code 255
            // ("argument list too long"). STDIN has no such limit.
            Cmd: ['sh', '-s'],
            OpenStdin: true,
            StdinOnce: true,
            AttachStdin: true,
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
                // into a directory it doesn't own, and CAP_CHOWN, which
                // it needs to hand the seeded tree back to UID 1000 so
                // the agent can write into it (syncBuiltinSkills). Keep
                // just those two so the helper stays heavily sandboxed.
                CapDrop: ['ALL'],
                CapAdd: ['DAC_OVERRIDE', 'CHOWN'],
                SecurityOpt: ['no-new-privileges'],
            },
        })
        // Attach to STDIN BEFORE starting so the helper's `sh -s`
        // doesn't hit EOF on an empty stream. We write the script and
        // close stdin (StdinOnce makes the container's stdin close when
        // we do), then the shell runs it and exits.
        const stdin = await this.attachContainerStdin(container.id)
        await container.start()
        await new Promise<void>((resolve, reject) => {
            stdin.write(script, (err) => {
                if (err) {
                    reject(err)
                    return
                }
                stdin.end(resolve)
            })
        })
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

    /**
     * Run a throwaway alpine helper with the agent's volume mounted at /v and
     * a short shell script. Returns the exit code + (de-framed) logs. Mirrors
     * the sandboxing of `seedVolumeFiles`. The script is passed via Cmd (it's
     * short and secret-free — URLs travel as env vars so they don't show up in
     * `docker inspect`).
     */
    private async runVolumeHelper(opts: {
        volume_name: string
        script: string
        env?: string[]
        readonly?: boolean
    }): Promise<{ code: number; logs: string }> {
        const helperImage = 'alpine:3.20'
        if (!(await this.imageExistsLocally(helperImage)))
            await this.pullImage(helperImage, () => {})

        const container = await this.docker.createContainer({
            Image: helperImage,
            Cmd: ['sh', '-c', opts.script],
            Env: opts.env,
            HostConfig: {
                AutoRemove: false,
                Mounts: [
                    {
                        Type: 'volume',
                        Source: opts.volume_name,
                        Target: '/v',
                        ReadOnly: !!opts.readonly,
                    },
                ],
                CapDrop: ['ALL'],
                CapAdd: ['DAC_OVERRIDE', 'CHOWN'],
                SecurityOpt: ['no-new-privileges'],
            },
        })
        try {
            await container.start()
            const result = await container.wait()
            const logsBuf = await container
                .logs({ stdout: true, stderr: true, follow: false })
                .catch(() => Buffer.from(''))
            return { code: result.StatusCode, logs: stripDockerFrames(logsBuf) }
        } finally {
            await container.remove({ force: true }).catch(() => undefined)
        }
    }

    /**
     * Tar the agent's /home/agent volume (gzip) and PUT it straight to a
     * pre-signed R2 URL — the bytes never touch the control. The volume is
     * mounted read-only; the tarball is staged in the helper's /tmp (host
     * overlay) so curl can send a Content-Length. Returns the uploaded size.
     */
    async backupVolume(volume_name: string, upload_url: string): Promise<{ size_bytes: number }> {
        const script = [
            'set -e',
            'apk add --no-cache curl >/dev/null 2>&1',
            'tar -C /v -czf /tmp/b.tgz .',
            'SZ=$(stat -c %s /tmp/b.tgz)',
            'curl -fsS -X PUT -H "Content-Type: application/octet-stream" --upload-file /tmp/b.tgz "$KJ_UPLOAD_URL"',
            'echo "KJ_BACKUP_SIZE=$SZ"',
        ].join('\n')
        const { code, logs } = await this.runVolumeHelper({
            volume_name,
            script,
            env: [`KJ_UPLOAD_URL=${upload_url}`],
            readonly: true,
        })
        if (code !== 0) throw new Error(`backup helper exited ${code}: ${logs.slice(-400)}`)
        const m = logs.match(/KJ_BACKUP_SIZE=(\d+)/)
        return { size_bytes: m ? Number(m[1]) : 0 }
    }

    /**
     * Download a backup tarball from a pre-signed R2 URL and extract it onto
     * the agent's volume, REPLACING its contents (wipe + extract). The caller
     * must stop the container first (a running agent holds the volume). Hands
     * the root back to UID 1000 so the agent can write at boot.
     */
    async restoreVolume(volume_name: string, download_url: string): Promise<void> {
        const script = [
            'set -e',
            'apk add --no-cache curl >/dev/null 2>&1',
            'curl -fsS "$KJ_DOWNLOAD_URL" -o /tmp/b.tgz',
            'find /v -mindepth 1 -delete',
            'tar -C /v -xzf /tmp/b.tgz',
            'chown 1000:1000 /v',
        ].join('\n')
        const { code, logs } = await this.runVolumeHelper({
            volume_name,
            script,
            env: [`KJ_DOWNLOAD_URL=${download_url}`],
        })
        if (code !== 0) throw new Error(`restore helper exited ${code}: ${logs.slice(-400)}`)
    }
}

/**
 * dockerode returns multiplexed stdout/stderr frames when Tty:false — each
 * carries an 8-byte header that leaks into the string. Strip non-printable
 * bytes (keep tab/lf + >= 0x20), best-effort.
 */
function stripDockerFrames(buf: Buffer | string): string {
    const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
    return s
        .split('')
        .filter((c) => {
            const code = c.charCodeAt(0)
            return code === 9 || code === 10 || code >= 32
        })
        .join('')
        .trim()
}
