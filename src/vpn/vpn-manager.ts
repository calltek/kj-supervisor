/**
 * The agent's Tailscale VPN (kj-app docs/red-por-agente.md §1), run by this
 * supervisor in a sidecar that shares only the agent's network (vpn-spec.ts).
 *
 * - **Who may use it** (decision 2026-11-17): everything the team does, by any
 *   channel; never a client's conversation. uid 1000 (the team's chats, shared)
 *   always may. An isolated uid may only once this supervisor has seen it is
 *   NOT a client's (`markSession` from `agent:input`, then `onUid` from the
 *   exec that gives it the uid), or it's a person's browser. Unknown = no:
 *   after a restart an internal isolated conversation is back on the tunnel
 *   with its next message.
 * - **The rules go in before the tunnel exists** (`KJVPN1` matches on the
 *   interface's name), so there is never a moment a client's uid can use it.
 * - **It outlives the agent's container**: the state is on its own volume, and
 *   when the agent starts again (`ensure`) the sidecar is made again and
 *   connects by itself, without a new login.
 * - **Connecting is a person's**: the control sends it; the agent can't.
 */

import type Docker from 'dockerode'

import type { KJLogger } from '../logger'
import {
    AUTH_KEY_ENV,
    buildVpnContainerSpec,
    keyLoginCommand,
    listProfilesCommand,
    loginCommand,
    logoutCommand,
    parseProfiles,
    parseTailscaleStatus,
    statusCommand,
    switchCommand,
    upCommand,
    validProfileId,
    type VpnProfile,
    validAuthKey,
    validHostname,
    vpnVolumeName,
    withMagicDns,
    withoutMagicDns,
    type VpnReport,
} from './vpn-spec'

/** What the manager needs from Docker (KJDocker), so tests can stand in for it. */
export interface VpnDocker {
    inspectOwnContainer(): Promise<{ image: string } | null>
    listKjContainers(): Promise<Array<{ agent_id: number | null; container_id: string }>>
    vpnSidecar(agent_id: number): Promise<{ running: boolean; network_mode?: string } | null>
    startVpnSidecar(spec: Docker.ContainerCreateOptions): Promise<void>
    removeVpnSidecar(agent_id: number): Promise<void>
    execInVpnSidecar(
        agent_id: number,
        cmd: string[],
        opts?: { detach?: boolean; timeout_ms?: number; env?: string[] }
    ): Promise<{ code: number; output: string }>
    readResolvConf(container_id: string): Promise<string>
    writeResolvConf(container_id: string, content: string): Promise<void>
    applyNetPolicy(container_id: string): Promise<void>
    allowVpnUid(agent_id: number, uid: number): boolean
    forgetVpnUids(agent_id: number): void
    removeVolume(name: string): Promise<void>
}

export type VpnStatusPush = { agent_id: number } & Omit<VpnReport, 'magic_dns_suffix'>

/** While someone logs in: often. Connected: now and then, as a refresh. */
const FAST_POLL_MS = 2_000
const FAST_POLL_FOR_MS = 10 * 60_000
const SLOW_POLL_MS = 5 * 60_000

interface Watch {
    timer: ReturnType<typeof setTimeout> | null
    fastUntil: number
    last: string
    /** The MagicDNS written into the agent's resolver, as `dns:<suffix>`; '' = none. */
    dns: string
}

export class VpnManager {
    /** Agents whose VPN is on, with their node name. */
    private readonly wanted = new Map<number, string>()
    /** Per agent, which conversation sessions are a client's (true) or the team's (false). */
    private readonly sessions = new Map<number, Map<string, boolean>>()
    private readonly watches = new Map<number, Watch>()
    /** One operation at a time per agent. */
    private readonly queue = new Map<number, Promise<unknown>>()

    constructor(
        private readonly deps: {
            docker: VpnDocker
            push: (status: VpnStatusPush) => void
            logger: KJLogger
            setTimer?: typeof setTimeout
        }
    ) {}

    /** Whether this agent has its VPN on (the control said so in spawn, sync or connect). */
    isWanted(agent_id: number): boolean {
        return this.wanted.has(agent_id)
    }

    // ── Who may use it ──────────────────────────────────────────────────

    /** From `agent:input`: whether this conversation session is a client's. */
    markSession(agent_id: number, session_id: string | undefined, client: boolean): void {
        if (!session_id) return
        const m = this.sessions.get(agent_id) ?? new Map<string, boolean>()
        // A session seen once as a client's stays one.
        m.set(session_id, client || m.get(session_id) === true)
        if (m.size > 5_000) m.delete(m.keys().next().value as string)
        this.sessions.set(agent_id, m)
    }

    /**
     * An isolated uid was just handed to a session (exec-dispatcher.ts). If it
     * is the team's — or a person's browser — it may use the tunnel.
     */
    async onUid(
        agent_id: number,
        container_id: string,
        session_id: string,
        uid: number,
        browser = false
    ): Promise<void> {
        const internal = browser || this.sessions.get(agent_id)?.get(session_id) === false
        if (!internal) return
        if (!this.deps.docker.allowVpnUid(agent_id, uid)) return
        if (!this.wanted.has(agent_id)) return
        await this.deps.docker
            .applyNetPolicy(container_id)
            .catch((err) =>
                this.deps.logger.warn(
                    { agent_id, err: err instanceof Error ? err.message : String(err) },
                    'vpn: could not open the tunnel to a new conversation'
                )
            )
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    /**
     * The agent is up with its VPN on (spawn, sync, a restart): the sidecar on
     * this container's network, made again if it isn't. No login: the state on
     * the volume reconnects it.
     */
    ensure(agent_id: number, container_id: string, hostname: string): Promise<void> {
        if (!validHostname(hostname)) return Promise.resolve()
        this.wanted.set(agent_id, hostname)
        return this.serial(agent_id, () => this.ensureSidecar(agent_id, container_id))
    }

    /** The control says this agent has its VPN on; it comes up when its container starts. */
    want(agent_id: number, hostname: string): void {
        if (validHostname(hostname)) this.wanted.set(agent_id, hostname)
    }

    /** The control said this agent has no VPN (spawn or sync without it). */
    notWanted(agent_id: number): void {
        if (!this.wanted.has(agent_id)) return
        this.wanted.delete(agent_id)
        this.stopWatch(agent_id)
        void this.deps.docker.removeVpnSidecar(agent_id)
    }

    /** A docker `start` of an agent's container (restart policy, a manual start). */
    onAgentStarted(agent_id: number, container_id: string): void {
        const hostname = this.wanted.get(agent_id)
        if (hostname) void this.ensure(agent_id, container_id, hostname)
    }

    /** The agent was stopped: the sidecar goes (its network did), the state stays. */
    onAgentStopped(agent_id: number): void {
        this.stopWatch(agent_id)
        void this.deps.docker.removeVpnSidecar(agent_id)
    }

    /** The agent was deleted: sidecar, state and everything known about it. */
    async onAgentDeleted(agent_id: number): Promise<void> {
        this.wanted.delete(agent_id)
        this.sessions.delete(agent_id)
        this.stopWatch(agent_id)
        this.deps.docker.forgetVpnUids(agent_id)
        await this.deps.docker.removeVpnSidecar(agent_id)
        await this.deps.docker.removeVolume(vpnVolumeName(agent_id))
    }

    // ── What a person does from the panel ───────────────────────────────

    /**
     * Connect: sidecar up and a login without a key; the login URL goes up in
     * the next status. `add` saves another account next to the ones there
     * (Tailscale's profiles, one active at a time) and makes it the active one;
     * `reauth` logs the active account in again (it expired). Throws
     * `not_running` when the agent has no container here.
     */
    connect(
        agent_id: number,
        hostname: string,
        mode: 'add' | 'reauth' = 'add',
        auth_key?: string
    ): Promise<void> {
        if (!validHostname(hostname)) return Promise.reject(new Error('bad hostname'))
        if (auth_key !== undefined && !validAuthKey(auth_key))
            return Promise.reject(new Error('bad auth key'))
        return this.serial(agent_id, async () => {
            const container_id = await this.containerOf(agent_id)
            if (!container_id) throw new Error('not_running')
            this.wanted.set(agent_id, hostname)
            await this.ensureSidecar(agent_id, container_id)
            const profiles = await this.profiles(agent_id)
            if (auth_key) {
                // With a key there's no browser step: it logs in now, or fails now.
                const verb = mode === 'reauth' || profiles.length === 0 ? 'up' : 'login'
                const r = await this.deps.docker.execInVpnSidecar(
                    agent_id,
                    keyLoginCommand(hostname, verb, mode === 'reauth'),
                    { timeout_ms: 75_000, env: [`${AUTH_KEY_ENV}=${auth_key}`] }
                )
                this.watch(agent_id, true)
                if (r.code !== 0)
                    throw new Error(
                        `auth key login failed: ${r.output.replaceAll(auth_key, '[redacted]').trim().slice(0, 200)}`
                    )
                return
            }
            // The first account goes with `up`; the next ones, with `login`.
            const cmd =
                mode === 'reauth'
                    ? upCommand(hostname, true)
                    : profiles.length === 0
                      ? upCommand(hostname)
                      : loginCommand(hostname)
            await this.deps.docker.execInVpnSidecar(agent_id, cmd, { detach: true })
            this.watch(agent_id, true)
        })
    }

    /** Make another saved account the active one (the panel, or the agent itself). */
    switchTo(agent_id: number, profile_id: string): Promise<void> {
        if (!validProfileId(profile_id)) return Promise.reject(new Error('bad profile'))
        return this.serial(agent_id, async () => {
            if (!this.wanted.has(agent_id)) throw new Error('not_connected')
            const known = (await this.profiles(agent_id)).some((p) => p.id === profile_id)
            if (!known) throw new Error('unknown_profile')
            const r = await this.deps.docker.execInVpnSidecar(agent_id, switchCommand(profile_id), {
                timeout_ms: 20_000,
            })
            if (r.code !== 0) throw new Error(`switch failed: ${r.output.trim().slice(0, 200)}`)
            this.watch(agent_id, true)
        })
    }

    /**
     * Forget one saved account: logged out of its tailnet. The active one is
     * replaced by another saved account; without any left, it's a disconnect.
     */
    removeProfile(agent_id: number, profile_id: string): Promise<void> {
        if (!validProfileId(profile_id)) return Promise.reject(new Error('bad profile'))
        const run = async (): Promise<'last' | 'done'> => {
            const profiles = await this.profiles(agent_id)
            const target = profiles.find((p) => p.id === profile_id)
            if (!target) throw new Error('unknown_profile')
            const others = profiles.filter((p) => p.id !== profile_id)
            if (others.length === 0) return 'last'
            const back = profiles.find((p) => p.active && p.id !== profile_id)
            const exec = (cmd: string[]) =>
                this.deps.docker.execInVpnSidecar(agent_id, cmd, { timeout_ms: 20_000 })
            if (!target.active) await exec(switchCommand(profile_id))
            await exec(logoutCommand())
            const next = back ?? others[0]
            if (next) await exec(switchCommand(next.id))
            this.watch(agent_id, true)
            return 'done'
        }
        return this.serial(agent_id, run).then((r) =>
            r === 'last' ? this.disconnect(agent_id) : undefined
        )
    }

    /** Disconnect: out of the tailnet, sidecar and state gone, resolver as it was. */
    disconnect(agent_id: number): Promise<void> {
        return this.serial(agent_id, async () => {
            this.wanted.delete(agent_id)
            this.stopWatch(agent_id)
            await this.deps.docker
                .execInVpnSidecar(agent_id, logoutCommand(), { timeout_ms: 15_000 })
                .catch(() => undefined)
            await this.deps.docker.removeVpnSidecar(agent_id)
            await this.deps.docker.removeVolume(vpnVolumeName(agent_id))
            const container_id = await this.containerOf(agent_id)
            if (container_id) await this.restoreDns(container_id)
            this.deps.push({ agent_id, state: 'stopped' })
        })
    }

    // ── Internals ───────────────────────────────────────────────────────

    private async ensureSidecar(agent_id: number, container_id: string): Promise<void> {
        const log = this.deps.logger.child({ agent_id, component: 'vpn' })
        const current = await this.deps.docker.vpnSidecar(agent_id)
        if (current?.running && current.network_mode === `container:${container_id}`) {
            this.watch(agent_id, false)
            return
        }
        const own = await this.deps.docker.inspectOwnContainer()
        if (!own) throw new Error('vpn_unavailable')
        // The rules first: KJVPN1 matches the tunnel's name, so it is in place
        // before tailscaled makes the interface.
        await this.deps.docker.applyNetPolicy(container_id)
        if (current) await this.deps.docker.removeVpnSidecar(agent_id)
        await this.deps.docker.startVpnSidecar(
            buildVpnContainerSpec({ agent_id, agent_container_id: container_id, image: own.image })
        )
        log.info('vpn sidecar started')
        this.watch(agent_id, false)
    }

    private async profiles(agent_id: number): Promise<VpnProfile[]> {
        const r = await this.deps.docker
            .execInVpnSidecar(agent_id, listProfilesCommand(), { timeout_ms: 10_000 })
            .catch(() => ({ code: -1, output: '' }))
        return parseProfiles(r.output)
    }

    private async status(agent_id: number): Promise<VpnReport> {
        try {
            const r = await this.deps.docker.execInVpnSidecar(agent_id, statusCommand(), {
                timeout_ms: 10_000,
            })
            // `status` exits non-zero when not logged in, but still prints JSON.
            const json = r.output.slice(r.output.indexOf('{'))
            const profiles = await this.profiles(agent_id)
            return { ...parseTailscaleStatus(json), profiles }
        } catch (err) {
            return { state: 'error', error: err instanceof Error ? err.message : String(err) }
        }
    }

    private watch(agent_id: number, fast: boolean): void {
        const w = this.watches.get(agent_id) ?? { timer: null, fastUntil: 0, last: '', dns: '' }
        if (fast) w.fastUntil = Date.now() + FAST_POLL_FOR_MS
        if (w.timer) clearTimeout(w.timer)
        this.watches.set(agent_id, w)
        const tick = async () => {
            w.timer = null
            if (!this.wanted.has(agent_id)) return
            await this.serial(agent_id, () => this.poll(agent_id, w))
            if (!this.wanted.has(agent_id) || this.watches.get(agent_id) !== w) return
            const delay = Date.now() < w.fastUntil ? FAST_POLL_MS : SLOW_POLL_MS
            w.timer = (this.deps.setTimer ?? setTimeout)(() => void tick(), delay)
            ;(w.timer as { unref?: () => void }).unref?.()
        }
        w.timer = (this.deps.setTimer ?? setTimeout)(() => void tick(), fast ? 500 : 1_000)
        ;(w.timer as { unref?: () => void }).unref?.()
    }

    private async poll(agent_id: number, w: Watch): Promise<void> {
        const report = await this.status(agent_id)
        if (report.state === 'connected') w.fastUntil = 0
        const { magic_dns_suffix, ...wire } = report
        // Each tailnet has its own MagicDNS suffix: switching accounts rewrites it.
        const dnsKey = `dns:${magic_dns_suffix ?? ''}`
        if (report.state === 'connected' && w.dns !== dnsKey) {
            const container_id = await this.containerOf(agent_id)
            if (container_id) {
                await this.applyDns(container_id, magic_dns_suffix)
                // The resolver changed: its DNS rule goes with the new one.
                await this.deps.docker.applyNetPolicy(container_id).catch(() => undefined)
                w.dns = dnsKey
            }
        }
        if (report.state !== 'connected') w.dns = ''
        const key = JSON.stringify(wire)
        // On every change, and as a refresh on each slow tick.
        if (key !== w.last || Date.now() >= w.fastUntil) {
            w.last = key
            this.deps.push({ agent_id, ...wire })
        }
    }

    private async applyDns(container_id: string, suffix?: string): Promise<void> {
        try {
            const resolv = await this.deps.docker.readResolvConf(container_id)
            const next = withMagicDns(resolv, suffix)
            if (next !== resolv) await this.deps.docker.writeResolvConf(container_id, next)
        } catch (err) {
            // The tunnel still works by address; only the tailnet's names don't.
            this.deps.logger.warn(
                { container_id, err: err instanceof Error ? err.message : String(err) },
                'vpn: could not point the agent at MagicDNS'
            )
        }
    }

    private async restoreDns(container_id: string): Promise<void> {
        try {
            const resolv = await this.deps.docker.readResolvConf(container_id)
            const clean = withoutMagicDns(resolv)
            if (clean !== resolv) await this.deps.docker.writeResolvConf(container_id, clean)
        } catch {
            /* the next start regenerates it anyway */
        }
    }

    private stopWatch(agent_id: number): void {
        const w = this.watches.get(agent_id)
        if (w?.timer) clearTimeout(w.timer)
        this.watches.delete(agent_id)
    }

    private async containerOf(agent_id: number): Promise<string | null> {
        const all = await this.deps.docker.listKjContainers().catch(() => [])
        return all.find((c) => c.agent_id === agent_id)?.container_id ?? null
    }

    private serial<T>(agent_id: number, fn: () => Promise<T>): Promise<T> {
        const prev = this.queue.get(agent_id) ?? Promise.resolve()
        const run = prev.catch(() => undefined).then(fn)
        const tail = run.catch(() => undefined)
        this.queue.set(agent_id, tail)
        void tail.then(() => {
            if (this.queue.get(agent_id) === tail) this.queue.delete(agent_id)
        })
        return run
    }
}
