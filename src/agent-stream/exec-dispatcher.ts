/**
 * Starting an agent's isolated conversations with their own uid, so its
 * container needs no root (kj-agent-base docs/aislamiento-sin-root.md).
 *
 * The launcher asks on its stdout:
 *
 *   { "kj_channel": "exec", "op": "spawn" | "purge" | "binaries" | "browser",
 *     "token": "<64 hex>", "session_id": "<sid>" }
 *
 * and this supervisor `docker exec`s the shim with that conversation's uid —
 * the uid chosen HERE, from a registry on the agent's isolation volume that
 * only root can write and the container has no root — and answers on stdin:
 *
 *   { "type": "exec", "token": "…", "ok": true, "uid": 200001 }
 *
 * What runs is fixed here, never taken from the request: the agent only names
 * which conversation, and the shim gets its work from the launcher afterwards.
 */
import type { KJLogger } from '../logger'
import { isValidSessionId } from '../handlers/agent-sessions-purge/session-paths'

/** First uid handed to a conversation, and the ceiling (same range as #107). */
export const UID_BASE = 200000
export const UID_MAX = 299999

/** The shim, as the supervisor runs it. Fixed: the agent never chooses. */
export const SHIM_CMD = [
    '/usr/local/bin/bun',
    '--cwd=/app',
    '--no-env-file',
    '/app/src/isolation/shim.ts',
]

/**
 * At most this many `docker exec` CALLS at once per agent. It bounds the load
 * on the Docker daemon, not the shims running: those count against the
 * container's own limits, like any process the agent starts.
 */
const MAX_IN_FLIGHT = 16

/** New conversations (new uids) an agent may start per minute. */
export const NEW_UIDS_PER_MINUTE = 30

/**
 * The uid that owns the Codex binaries on the isolation volume (`bin`, made
 * so by prepareExecIsolationVolume). Op `binaries` always runs as it: no
 * conversation uid ever writes what the others execute.
 */
export const BINARIES_UID = 998

/**
 * A person's web browser in an agent (kj-app docs/navegador-integrado.md §9)
 * runs with its own uid, registered under `kj-browser-<user_id>`. That key is
 * good ONLY with op `browser`, and op `browser` only with it: otherwise a
 * conversation whose id were `kj-browser-7` would run as that browser's uid
 * and read its profile — that person's sessions.
 */
export const BROWSER_SESSION_RE = /^kj-browser-[1-9][0-9]{0,11}$/

export interface ExecRequest {
    kj_channel: 'exec'
    op: 'spawn' | 'purge' | 'binaries' | 'browser'
    token: string
    session_id: string
}

export function isExecRequest(
    line: Record<string, unknown>
): line is ExecRequest & Record<string, unknown> {
    return line.kj_channel === 'exec'
}

/** What a request must look like to be acted on. */
export function validExecRequest(
    r: Record<string, unknown>
): r is ExecRequest & Record<string, unknown> {
    return (
        r.kj_channel === 'exec' &&
        (r.op === 'spawn' || r.op === 'purge' || r.op === 'binaries' || r.op === 'browser') &&
        typeof r.token === 'string' &&
        /^[0-9a-f]{64}$/.test(r.token) &&
        isValidSessionId(r.session_id) &&
        (r.op === 'browser') === BROWSER_SESSION_RE.test(r.session_id as string)
    )
}

interface Registry {
    bySession: Record<string, number>
    next: number
}

/** Parse a stored registry, dropping anything out of range or malformed. */
export function parseRegistry(json: string | null): Registry {
    const reg: Registry = { bySession: {}, next: UID_BASE }
    if (!json) return reg
    const parsed = JSON.parse(json) as Partial<Registry>
    for (const [sid, uid] of Object.entries(parsed.bySession ?? {})) {
        if (!isValidSessionId(sid)) continue
        if (!Number.isInteger(uid) || uid < UID_BASE || uid > UID_MAX) continue
        reg.bySession[sid] = uid
        reg.next = Math.max(reg.next, uid + 1)
    }
    if (typeof parsed.next === 'number' && parsed.next > reg.next && parsed.next <= UID_MAX + 1)
        reg.next = parsed.next
    return reg
}

/**
 * conversation → uid for ONE agent. Registered, never a hash: two
 * conversations sharing a uid would see each other's files.
 *
 * It lives on the agent's isolation volume (`registry/uids.json`: the dir
 * root `0700`, the file `0600`) — the same file the root launcher kept, so
 * nothing to migrate, and it travels with the agent's backups. Nothing in the
 * container can write it: it has no root. Only this supervisor's helper does,
 * and only when a NEW conversation gets its uid; reads come from memory.
 *
 * A uid is handed out only once it is SAVED: one handed out and then lost
 * would go to another conversation after a restart. New uids are made one at
 * a time, and each starts from the registry AS IT IS ON THE VOLUME (another
 * launcher, or a restored backup, may have added uids since it was read); a
 * second request for the same conversation waits for the same save.
 */
export class UidRegistry {
    /** Saves, one after another; a failed one doesn't stop the next. */
    private writes: Promise<void> = Promise.resolve()
    private readonly pending = new Map<string, Promise<number>>()
    /** When the last new uids were handed out, for NEW_UIDS_PER_MINUTE. */
    private readonly recent: number[] = []

    constructor(
        private reg: Registry,
        private readonly store: {
            read: () => Promise<string | null>
            write: (json: string) => Promise<void>
        },
        private readonly now: () => number = Date.now
    ) {}

    uidOf(session_id: string): number | undefined {
        return this.reg.bySession[session_id]
    }

    /** The conversation's uid, assigning (and saving) the next one if it has none. */
    uidFor(session_id: string): Promise<number> {
        const have = this.reg.bySession[session_id]
        if (have !== undefined) return Promise.resolve(have)
        const inFlight = this.pending.get(session_id)
        if (inFlight) return inFlight
        const saved = this.writes.then(async () => {
            const onVolume = parseRegistry(await this.store.read())
            const known = onVolume.bySession[session_id]
            if (known !== undefined) {
                this.reg.bySession[session_id] = known
                return known
            }
            // A runaway launcher could otherwise burn the range and fill the
            // daemon with helpers.
            const t = this.now()
            while (this.recent.length && t - (this.recent[0] ?? 0) > 60_000) this.recent.shift()
            if (this.recent.length >= NEW_UIDS_PER_MINUTE)
                throw new Error('too many new conversations')
            const uid = Math.max(onVolume.next, this.reg.next)
            if (uid > UID_MAX) throw new Error('uid range exhausted')
            const next: Registry = {
                bySession: { ...this.reg.bySession, ...onVolume.bySession, [session_id]: uid },
                next: uid + 1,
            }
            await this.store.write(JSON.stringify(next))
            this.recent.push(t)
            this.reg = next
            return uid
        })
        this.writes = saved.then(
            () => {},
            () => {}
        )
        const result = saved.finally(() => this.pending.delete(session_id))
        this.pending.set(session_id, result)
        return result
    }
}

export interface ExecDocker {
    containerIsolationMode(container_id: string): Promise<'none' | 'root' | 'exec'>
    isolationVolumeOf(container_id: string): Promise<string | null>
    readUidRegistry(volume_name: string): Promise<string | null>
    writeUidRegistry(volume_name: string, json: string): Promise<void>
    /** Cut the server's network for a browser uid (browser-fence.ts); throws if it didn't. */
    fenceBrowserNetwork(container_id: string, uid: number): Promise<void>
    execDetached(opts: {
        container_id: string
        user: string
        cmd: string[]
        env: string[]
    }): Promise<void>
}

export class ExecDispatcher {
    private readonly modes = new Map<string, Promise<'none' | 'root' | 'exec'>>()
    private readonly registries = new Map<
        number,
        { container_id: string; registry: Promise<UidRegistry> }
    >()
    private readonly inFlight = new Map<number, number>()

    constructor(
        private readonly deps: {
            docker: ExecDocker
            /** Answer on the container's stdin (a control envelope). */
            reply: (agent_id: number, envelope: { type: string; [k: string]: unknown }) => boolean
            logger: KJLogger
        }
    ) {}

    async onRequest(
        agent_id: number,
        container_id: string,
        line: Record<string, unknown>
    ): Promise<void> {
        const log = this.deps.logger.child({ agent_id })
        if (!validExecRequest(line)) {
            log.warn({ op: line.op }, 'exec: malformed request ignored')
            return
        }
        const { op, token, session_id } = line
        const answer = (ok: boolean, extra: Record<string, unknown> = {}) =>
            this.deps.reply(agent_id, { type: 'exec', token, ok, ...extra })

        const busy = this.inFlight.get(agent_id) ?? 0
        if (busy >= MAX_IN_FLIGHT) {
            answer(false, { error: 'too many at once' })
            return
        }
        this.inFlight.set(agent_id, busy + 1)
        try {
            if ((await this.modeOf(container_id)) !== 'exec') {
                log.warn({ op }, 'exec: refused — the image does not isolate through exec')
                answer(false, { error: 'not an exec-uid image' })
                return
            }
            const registry = await this.registryOf(agent_id, container_id)
            const uid =
                op === 'binaries'
                    ? BINARIES_UID
                    : op === 'purge'
                      ? registry.uidOf(session_id)
                      : await registry.uidFor(session_id)
            if (uid === undefined) {
                answer(false, { error: 'unknown conversation' })
                return
            }
            // A person's browser never starts on the server's network: the fence
            // goes in first, and if it can't, there is no browser.
            if (op === 'browser') await this.deps.docker.fenceBrowserNetwork(container_id, uid)
            await this.deps.docker.execDetached({
                container_id,
                user: `${uid}:${uid}`,
                cmd: SHIM_CMD,
                env: [`KJ_EXEC_TOKEN=${token}`],
            })
            log.info({ op, session_id, uid }, 'exec: started an isolated shim')
            answer(true, { uid })
        } catch (err) {
            log.warn(
                { op, session_id, err: err instanceof Error ? err.message : String(err) },
                'exec: could not start the shim'
            )
            answer(false, { error: 'exec failed' })
        } finally {
            this.inFlight.set(agent_id, (this.inFlight.get(agent_id) ?? 1) - 1)
        }
    }

    /** A container's image never changes: its answer is kept. A failed inspect is not. */
    private modeOf(container_id: string): Promise<'none' | 'root' | 'exec'> {
        let m = this.modes.get(container_id)
        if (!m) {
            m = this.deps.docker.containerIsolationMode(container_id)
            this.modes.set(container_id, m)
            m.catch(() => this.modes.delete(container_id))
        }
        return m.catch(() => 'none' as const)
    }

    /**
     * The registry is read again from the volume for every new CONTAINER of
     * the agent: in between, an image with a root launcher may have handed out
     * uids of its own, and an old copy here would hand them out again.
     */
    private registryOf(agent_id: number, container_id: string): Promise<UidRegistry> {
        const have = this.registries.get(agent_id)
        if (have && have.container_id === container_id) return have.registry
        const registry = this.openRegistry(container_id)
        this.registries.set(agent_id, { container_id, registry })
        registry.catch(() => {
            if (this.registries.get(agent_id)?.registry === registry)
                this.registries.delete(agent_id)
        })
        return registry
    }

    private async openRegistry(container_id: string): Promise<UidRegistry> {
        const volume = await this.deps.docker.isolationVolumeOf(container_id)
        if (!volume) throw new Error('no isolation volume')
        const reg = parseRegistry(await this.deps.docker.readUidRegistry(volume))
        return new UidRegistry(reg, {
            read: () => this.deps.docker.readUidRegistry(volume),
            write: (json) => this.deps.docker.writeUidRegistry(volume, json),
        })
    }
}
