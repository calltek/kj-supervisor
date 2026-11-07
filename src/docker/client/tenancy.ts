/**
 * Who this machine serves (kj-backend docs/servidor-compartido.md).
 *
 * DEDICATED, the default and every machine until now: one organization, its
 * own box. SHARED: the agents of several organizations — a partner's clients,
 * or Kujira's demos — on one machine. A shared machine is STRICTER than a
 * dedicated one, never the same: one tenant must not reach, read or starve
 * another. What only makes sense on the customer's own box (its LAN, a model
 * on the host, a VPN) doesn't exist there.
 *
 * The control says which one this is (`server:hello` ack, `server:tenancy`).
 * The supervisor refuses on its side too: two locks, so a bug in one of them
 * doesn't put a tenant on a machine that would let it through.
 *
 * What applies to EVERY machine lives here too, so both paths read it from one
 * place: the pids cap on agents and the limits on our helper containers.
 */

export type Tenancy = 'dedicated' | 'shared'

/** The control's word for it (`SHARED` / `DEDICATED`), or anything else → dedicated. */
export function normalizeTenancy(raw: unknown): Tenancy {
    return typeof raw === 'string' && raw.toLowerCase() === 'shared' ? 'shared' : 'dedicated'
}

/**
 * Processes (threads count) one agent container may have, on every machine.
 * A fork bomb in one agent otherwise exhausts the host's pids. Generous on
 * purpose: Chromium, Playwright and several conversations run hundreds of
 * threads, and a cap that trips a real agent is worse than none.
 */
export const AGENT_PIDS_LIMIT = 4096

/** Our own short-lived helpers (seed, backup, restore, network rules, quotas). */
export const HELPER_LIMITS = {
    Memory: 512 * 1024 * 1024,
    PidsLimit: 256,
} as const

/** The posture of a helper that needs no capability at all. */
export const HELPER_HARDENING = {
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
} as const

/** Where agent images come from. On a shared machine nothing else is run. */
export const AGENT_IMAGE_REGISTRY = 'ghcr.io/calltek/'

/** Disk one agent may use on a shared machine when the control doesn't say. */
export const SHARED_DEFAULT_DISK_GB = 20

export interface SharedSpawnCheck {
    image_tag: string
    memory_mb: number
    cpu: number
    network_privileged?: boolean
    /** How the image isolates conversations (hardening.ts `isolationModeOf`). */
    isolation_mode: 'none' | 'root' | 'exec'
    /** Whether this host enforces disk quotas (xfs + pquota under Docker). */
    disk_quota: boolean
}

/** Why an agent can't start on a shared machine, as a machine code. */
export type SharedRefusal =
    | 'shared_no_limits'
    | 'shared_network_privileged'
    | 'shared_root_isolation'
    | 'shared_foreign_image'
    | 'shared_no_disk_quota'

/**
 * Null when the agent may start on a shared machine; otherwise the first
 * reason it may not. Pure, so the rule is tested without Docker.
 */
export function sharedSpawnRefusal(c: SharedSpawnCheck): SharedRefusal | null {
    if (!(c.memory_mb > 0) || !(c.cpu > 0)) return 'shared_no_limits'
    if (c.network_privileged) return 'shared_network_privileged'
    if (c.isolation_mode === 'root') return 'shared_root_isolation'
    if (!c.image_tag.startsWith(AGENT_IMAGE_REGISTRY)) return 'shared_foreign_image'
    if (!c.disk_quota) return 'shared_no_disk_quota'
    return null
}

/** What the panel shows (the control translates by code; this is the log's). */
export const SHARED_REFUSAL_TEXT: Record<SharedRefusal, string> = {
    shared_no_limits: 'shared server: the agent needs a memory and CPU limit',
    shared_network_privileged: 'shared server: privileged networking (VPN) is not available',
    shared_root_isolation: 'shared server: images with a root launcher are not allowed',
    shared_foreign_image: `shared server: only images from ${AGENT_IMAGE_REGISTRY} run here`,
    shared_no_disk_quota: 'shared server: this host does not enforce disk quotas',
}

export class SharedSpawnRefusedError extends Error {
    constructor(readonly code: SharedRefusal) {
        super(SHARED_REFUSAL_TEXT[code])
        this.name = 'SharedSpawnRefusedError'
    }
}

/** The disk ceiling of an agent's volume couldn't be set: it doesn't start. */
export class VolumeQuotaError extends Error {
    constructor(message: string) {
        super(`volume quota: ${message}`)
        this.name = 'VolumeQuotaError'
    }
}

/**
 * Whether this host can be shared, reported in `server:hello` so the panel
 * only offers «Compartir con mis clientes» where it holds. `missing` names
 * what's absent, in the order a person would fix it.
 */
export interface SharedReadiness {
    ready: boolean
    missing: Array<'userns_remap' | 'disk_quota' | 'network_rules'>
}

export function sharedReadiness(h: {
    userns_remap: boolean
    disk_quota: boolean
    network_rules: boolean
}): SharedReadiness {
    const missing: SharedReadiness['missing'] = []
    if (!h.userns_remap) missing.push('userns_remap')
    if (!h.disk_quota) missing.push('disk_quota')
    if (!h.network_rules) missing.push('network_rules')
    return { ready: missing.length === 0, missing }
}

/** XFS project id of an agent's home volume (one project per agent). */
export function quotaProjectId(agent_id: number): number {
    if (!Number.isInteger(agent_id) || agent_id <= 0) throw new Error(`bad agent id: ${agent_id}`)
    return 1_000_000 + agent_id
}

/**
 * The quota helper's script: make the volume's directory an XFS project and
 * cap it. `mount` is the XFS filesystem Docker's root lives on, `dir` the
 * volume's `_data` under it. Both come from the daemon, never from the
 * control, and are checked to be plain absolute paths before they get here.
 */
export function buildQuotaScript(mount: string, dir: string, project: number, gb: number): string {
    const safe = /^\/[A-Za-z0-9._/-]+$/
    if (!safe.test(mount) || !safe.test(dir)) throw new Error('bad quota path')
    if (!Number.isInteger(project) || project <= 0) throw new Error('bad quota project')
    if (!Number.isInteger(gb) || gb <= 0 || gb > 10_000) throw new Error('bad quota size')
    return [
        'set -eu',
        `xfs_quota -x -c 'project -s -p ${dir} ${project}' ${mount} >/dev/null`,
        `xfs_quota -x -c 'limit -p bhard=${gb}g ${project}' ${mount}`,
        'echo quota',
    ].join('\n')
}
