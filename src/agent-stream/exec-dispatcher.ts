/**
 * Starting an agent's isolated conversations with their own uid, so its
 * container needs no root (kj-agent-base docs/aislamiento-sin-root.md).
 *
 * The launcher asks on its stdout:
 *
 *   { "kj_channel": "exec", "op": "spawn" | "purge", "token": "<64 hex>", "session_id": "<sid>" }
 *
 * and this supervisor `docker exec`s the shim with that conversation's uid —
 * the uid chosen HERE, from a registry kept on the supervisor's disk, where
 * nothing in the container can edit it — and answers on stdin:
 *
 *   { "type": "exec", "token": "…", "ok": true, "uid": 200001 }
 *
 * What runs is fixed here, never taken from the request: the agent only names
 * which conversation, and the shim gets its work from the launcher afterwards.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

export interface ExecRequest {
    kj_channel: 'exec'
    op: 'spawn' | 'purge'
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
        (r.op === 'spawn' || r.op === 'purge') &&
        typeof r.token === 'string' &&
        /^[0-9a-f]{64}$/.test(r.token) &&
        isValidSessionId(r.session_id)
    )
}

interface Registry {
    bySession: Record<string, number>
    next: number
}

/**
 * conversation → uid for ONE agent, on the supervisor's disk. Registered, never
 * a hash: two conversations sharing a uid would see each other's files.
 */
export class UidRegistry {
    private reg: Registry | null = null

    constructor(private readonly path: string) {}

    exists(): boolean {
        return existsSync(this.path)
    }

    uidOf(session_id: string): number | undefined {
        return this.load().bySession[session_id]
    }

    uidFor(session_id: string): number {
        const reg = this.load()
        const have = reg.bySession[session_id]
        if (have !== undefined) return have
        if (reg.next > UID_MAX) throw new Error('uid range exhausted')
        const uid = reg.next
        reg.bySession[session_id] = uid
        reg.next = uid + 1
        this.save(reg)
        return uid
    }

    /**
     * Take over the registry a root launcher kept (`registry/uids.json` on
     * the isolation volume), once, when this agent has none here yet: its
     * conversations keep their uids, and so the HOMEs they own.
     */
    importLegacy(json: string): number {
        const parsed = JSON.parse(json) as Partial<Registry>
        const bySession: Record<string, number> = {}
        let next = UID_BASE
        for (const [sid, uid] of Object.entries(parsed.bySession ?? {})) {
            if (!isValidSessionId(sid)) continue
            if (!Number.isInteger(uid) || uid < UID_BASE || uid > UID_MAX) continue
            bySession[sid] = uid
            next = Math.max(next, uid + 1)
        }
        if (typeof parsed.next === 'number' && parsed.next > next && parsed.next <= UID_MAX + 1)
            next = parsed.next
        this.save({ bySession, next })
        return Object.keys(bySession).length
    }

    private load(): Registry {
        if (this.reg) return this.reg
        if (!existsSync(this.path)) {
            this.reg = { bySession: {}, next: UID_BASE }
            return this.reg
        }
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Registry
        this.reg = { bySession: parsed.bySession ?? {}, next: parsed.next ?? UID_BASE }
        return this.reg
    }

    private save(reg: Registry): void {
        const dir = join(this.path, '..')
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const tmp = `${this.path}.tmp`
        writeFileSync(tmp, JSON.stringify(reg), { mode: 0o600 })
        renameSync(tmp, this.path)
        chmodSync(this.path, 0o600)
        this.reg = reg
    }
}

export interface ExecDocker {
    containerIsolationMode(container_id: string): Promise<'none' | 'root' | 'exec'>
    isolationVolumeOf(container_id: string): Promise<string | null>
    readLegacyUidRegistry(volume_name: string): Promise<string | null>
    execDetached(opts: { container_id: string; user: string; cmd: string[]; env: string[] }): Promise<void>
}

export class ExecDispatcher {
    private readonly modes = new Map<string, Promise<'none' | 'root' | 'exec'>>()
    private readonly registries = new Map<number, Promise<UidRegistry>>()
    private readonly inFlight = new Map<number, number>()

    constructor(
        private readonly deps: {
            docker: ExecDocker
            /** `<config_dir>/isolation`. */
            registryDir: string
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
            const uid = op === 'purge' ? registry.uidOf(session_id) : registry.uidFor(session_id)
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
            r = this.openRegistry(agent_id, container_id)
            this.registries.set(agent_id, r)
            r.catch(() => this.registries.delete(agent_id))
        }
        return r
    }

    private async openRegistry(agent_id: number, container_id: string): Promise<UidRegistry> {
        const registry = new UidRegistry(join(this.deps.registryDir, `agent-${agent_id}.json`))
        if (registry.exists()) return registry
        const volume = await this.deps.docker.isolationVolumeOf(container_id)
        const legacy = volume ? await this.deps.docker.readLegacyUidRegistry(volume) : null
        if (legacy) {
            const n = registry.importLegacy(legacy)
            this.deps.logger.info({ agent_id, conversations: n }, 'exec: took over the root launcher uid registry')
        }
        return registry
    }
}
