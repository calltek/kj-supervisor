/**
 * Starting an agent's isolated conversations with their own uid, so its
 * container needs no root (kj-agent-base docs/aislamiento-sin-root.md).
 *
 * The launcher asks on its stdout:
 *
 *   { "kj_channel": "exec", "op": "spawn" | "purge", "token": "<64 hex>", "session_id": "<sid>" }
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

/** At most this many execs in flight per agent: a runaway launcher can't fork-bomb the host. */
const MAX_IN_FLIGHT = 16

/**
 * The uid that owns the Codex binaries on the isolation volume (`bin`, made
 * so by prepareExecIsolationVolume). Op `binaries` always runs as it: no
 * conversation uid ever writes what the others execute.
 */
export const BINARIES_UID = 998

export interface ExecRequest {
    kj_channel: 'exec'
    op: 'spawn' | 'purge' | 'binaries'
    token: string
    session_id: string
}

export function isExecRequest(line: Record<string, unknown>): line is ExecRequest & Record<string, unknown> {
    return line.kj_channel === 'exec'
}

/** What a request must look like to be acted on. */
export function validExecRequest(r: Record<string, unknown>): r is ExecRequest & Record<string, unknown> {
    return (
        r.kj_channel === 'exec' &&
        (r.op === 'spawn' || r.op === 'purge' || r.op === 'binaries') &&
        typeof r.token === 'string' &&
        /^[0-9a-f]{64}$/.test(r.token) &&
        isValidSessionId(r.session_id)
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
 * It lives on the agent's isolation volume (`registry/uids.json`, root `0700`)
 * — the same file the root launcher kept, so nothing to migrate, and it travels
 * with the agent's backups. Nothing in the container can write it: it has no
 * root. Only this supervisor's helper does, and only when a NEW conversation
 * gets its uid; reads come from memory.
 */
export class UidRegistry {
    private writes: Promise<void> = Promise.resolve()

    constructor(
        private reg: Registry,
        private readonly persist: (json: string) => Promise<void>
    ) {}

    uidOf(session_id: string): number | undefined {
        return this.reg.bySession[session_id]
    }

    /** The conversation's uid, assigning (and saving) the next one if it has none. */
    async uidFor(session_id: string): Promise<number> {
        const have = this.reg.bySession[session_id]
        if (have !== undefined) return have
        if (this.reg.next > UID_MAX) throw new Error('uid range exhausted')
        const uid = this.reg.next
        this.reg.bySession[session_id] = uid
        this.reg.next = uid + 1
        const json = JSON.stringify(this.reg)
        // Saved before anyone runs as it: a uid handed out and then lost would
        // be handed again to another conversation.
        this.writes = this.writes.then(() => this.persist(json))
        await this.writes
        return uid
    }
}

export interface ExecDocker {
    containerIsolationMode(container_id: string): Promise<'none' | 'root' | 'exec'>
    isolationVolumeOf(container_id: string): Promise<string | null>
    readUidRegistry(volume_name: string): Promise<string | null>
    writeUidRegistry(volume_name: string, json: string): Promise<void>
    execDetached(opts: { container_id: string; user: string; cmd: string[]; env: string[] }): Promise<void>
}

export class ExecDispatcher {
    private readonly modes = new Map<string, Promise<'none' | 'root' | 'exec'>>()
    private readonly registries = new Map<number, Promise<UidRegistry>>()
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

    /** A recreated container has another id; forget what we knew of the old one. */
    forgetContainer(container_id: string): void {
        this.modes.delete(container_id)
    }

    private modeOf(container_id: string): Promise<'none' | 'root' | 'exec'> {
        let m = this.modes.get(container_id)
        if (!m) {
            m = this.deps.docker.containerIsolationMode(container_id).catch(() => 'none' as const)
            this.modes.set(container_id, m)
        }
        return m
    }

    private registryOf(agent_id: number, container_id: string): Promise<UidRegistry> {
        let r = this.registries.get(agent_id)
        if (!r) {
            r = this.openRegistry(container_id)
            this.registries.set(agent_id, r)
            r.catch(() => this.registries.delete(agent_id))
        }
        return r
    }

    private async openRegistry(container_id: string): Promise<UidRegistry> {
        const volume = await this.deps.docker.isolationVolumeOf(container_id)
        if (!volume) throw new Error('no isolation volume')
        const reg = parseRegistry(await this.deps.docker.readUidRegistry(volume))
        return new UidRegistry(reg, (json) => this.deps.docker.writeUidRegistry(volume, json))
    }
}
