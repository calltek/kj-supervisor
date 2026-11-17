/**
 * The agent's Tailscale VPN (kj-app docs/red-por-agente.md §1): what the
 * sidecar container is, the commands run in it and how its status reads.
 *
 * Pure on purpose, like the kj-keychain spec: what this container may touch is
 * the point, so it is built in one function a test can read whole.
 *
 * - **Its own container, the agent's network.** `container:<agent>` shares only
 *   the network namespace: the agent's files and processes stay out of reach,
 *   and the agent (no root, no capabilities) can't see or stop tailscaled.
 * - **NET_ADMIN and /dev/net/tun, nothing else.** A real interface
 *   (`tailscale0`) in the agent's namespace, so ssh, ping and UDP work and the
 *   LANs behind a subnet router come with `--accept-routes`.
 * - **State on its own volume** (`kj-agent-<id>-vpn`): without it every restart
 *   would ask for the login again. It holds the node key; it goes with a
 *   disconnect and with the agent.
 * - **Never the `kj-agent` label**: reconciliation would take it for an orphan
 *   agent and the control would stop it (same as kj-keychain).
 * - **tailscaled leaves the firewall alone** (`--netfilter-mode=off`) and the
 *   DNS too (`--accept-dns=false`): who may use the tunnel is ours to say, in
 *   the agent's rules (net-policy.ts, `KJVPN1`), and the resolver is written by
 *   the supervisor.
 */

import type Docker from 'dockerode'

export const VPN_LABEL = 'kj-vpn'
export const VPN_LABEL_AGENT_ID = 'kj-vpn-agent-id'
export const VPN_INTERFACE = 'tailscale0'
export const VPN_STATE_DIR = '/var/lib/tailscale'
export const VPN_SOCKET = '/run/tailscale/tailscaled.sock'
/** MagicDNS: tailscaled answers the tailnet's names here, over the tunnel. */
export const MAGIC_DNS = '100.100.100.100'
export const VPN_MEMORY_BYTES = 256 * 1024 * 1024

export const vpnContainerName = (agent_id: number) => `kj-vpn-${agent_id}`
export const vpnVolumeName = (agent_id: number) => `kj-agent-${agent_id}-vpn`

export interface VpnContainerOptions {
    agent_id: number
    /** The agent's container: the sidecar joins its network namespace. */
    agent_container_id: string
    /** The supervisor's own image, which carries tailscale (Dockerfile). */
    image: string
}

export function buildVpnContainerSpec(o: VpnContainerOptions): Docker.ContainerCreateOptions {
    return {
        name: vpnContainerName(o.agent_id),
        Image: o.image,
        Entrypoint: [
            'tailscaled',
            `--state=${VPN_STATE_DIR}/tailscaled.state`,
            `--statedir=${VPN_STATE_DIR}`,
            `--socket=${VPN_SOCKET}`,
            `--tun=${VPN_INTERFACE}`,
            '--no-logs-no-support',
        ],
        // The image's own Cmd would be appended to the entrypoint.
        Cmd: [],
        // The supervisor's image runs as `kj`; a kernel tunnel needs root, and
        // this root has NET_ADMIN and nothing else.
        User: '0:0',
        Labels: { [VPN_LABEL]: 'true', [VPN_LABEL_AGENT_ID]: String(o.agent_id) },
        HostConfig: {
            NetworkMode: `container:${o.agent_container_id}`,
            CapDrop: ['ALL'],
            CapAdd: ['NET_ADMIN'],
            Devices: [
                {
                    PathOnHost: '/dev/net/tun',
                    PathInContainer: '/dev/net/tun',
                    CgroupPermissions: 'rwm',
                },
            ],
            SecurityOpt: ['no-new-privileges'],
            ReadonlyRootfs: true,
            Tmpfs: { '/run': 'rw,nosuid,size=8m', '/tmp': 'rw,noexec,nosuid,size=16m' },
            Mounts: [
                {
                    Type: 'volume',
                    Source: vpnVolumeName(o.agent_id),
                    Target: VPN_STATE_DIR,
                },
            ],
            // Its network dies with the agent's container: the supervisor makes
            // it again when the agent starts (vpn-manager.ts), never Docker.
            RestartPolicy: { Name: 'no' },
            Memory: VPN_MEMORY_BYTES,
            PidsLimit: 64,
        },
    }
}

/** A node name Tailscale accepts and that can't be read as a flag. */
export function validHostname(h: unknown): h is string {
    return typeof h === 'string' && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h)
}

const ts = (...args: string[]) => ['tailscale', `--socket=${VPN_SOCKET}`, ...args]

/**
 * `tailscale up` without a key: it prints a login URL and waits for it. Run
 * detached; the URL is read from `status`. With `reauth`, a node already in a
 * tailnet asks for a new login (connect again, another account).
 */
export function upCommand(hostname: string, reauth = false): string[] {
    if (!validHostname(hostname)) throw new Error(`bad vpn hostname: ${hostname}`)
    return ts(
        'up',
        `--hostname=${hostname}`,
        '--accept-routes',
        '--accept-dns=false',
        '--netfilter-mode=off',
        ...(reauth ? ['--force-reauth'] : [])
    )
}

export const statusCommand = () => ts('status', '--json')
export const logoutCommand = () => ts('logout')

export type VpnState = 'starting' | 'needs_login' | 'connected' | 'expired' | 'stopped' | 'error'

/** What goes up in `agent:vpn:status` (besides `agent_id`). */
export interface VpnReport {
    state: VpnState
    auth_url?: string
    ip?: string
    hostname?: string
    tailnet?: string
    login?: string
    key_expiry?: string
    error?: string
    /** The tailnet's MagicDNS suffix, when MagicDNS is on (kept here, not sent). */
    magic_dns_suffix?: string
}

interface TailscaleStatus {
    BackendState?: string
    AuthURL?: string
    Self?: {
        HostName?: string
        DNSName?: string
        TailscaleIPs?: string[]
        KeyExpiry?: string
        Expired?: boolean
        UserID?: number
    }
    CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string; MagicDNSEnabled?: boolean } | null
    User?: Record<string, { LoginName?: string }> | null
}

const str = (v: unknown, max = 256) =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined

/**
 * `tailscale status --json` as a report. Unknown or unreadable → `starting`:
 * tailscaled answers this before it has a state, and that's what it means.
 */
export function parseTailscaleStatus(raw: string): VpnReport {
    let s: TailscaleStatus
    try {
        s = JSON.parse(raw) as TailscaleStatus
    } catch {
        return { state: 'starting' }
    }
    const self = s.Self ?? {}
    const auth_url = str(s.AuthURL, 512)
    const ipv4 = (self.TailscaleIPs ?? []).find((ip) => typeof ip === 'string' && ip.includes('.'))
    const login =
        self.UserID !== undefined ? str(s.User?.[String(self.UserID)]?.LoginName) : undefined
    const details: VpnReport = {
        state: 'starting',
        ...(ipv4 ? { ip: ipv4 } : {}),
        ...(str(self.HostName, 63) ? { hostname: str(self.HostName, 63) } : {}),
        ...(str(s.CurrentTailnet?.Name) ? { tailnet: str(s.CurrentTailnet?.Name) } : {}),
        ...(login ? { login } : {}),
        ...(str(self.KeyExpiry, 40) ? { key_expiry: str(self.KeyExpiry, 40) } : {}),
        ...(s.CurrentTailnet?.MagicDNSEnabled && str(s.CurrentTailnet.MagicDNSSuffix)
            ? { magic_dns_suffix: str(s.CurrentTailnet.MagicDNSSuffix) }
            : {}),
    }
    switch (s.BackendState) {
        case 'Running':
            return { ...details, state: self.Expired ? 'expired' : 'connected' }
        case 'NeedsLogin':
            // A login URL is a login in progress; without one, a node that had
            // a key lost it (expired, or logged out from the console).
            if (auth_url) return { state: 'needs_login', auth_url }
            return { ...details, state: details.key_expiry ? 'expired' : 'stopped' }
        case 'NeedsMachineAuth':
            // Logged in, waiting for an admin of the tailnet to approve it.
            return { ...details, state: 'needs_login' }
        case 'Stopped':
            return { ...details, state: 'stopped' }
        default:
            return { state: 'starting' }
    }
}

/**
 * The agent's resolv.conf with MagicDNS first, so the tailnet's names resolve,
 * and short timeouts, so a tunnel that's down costs a second, not five. What
 * we add goes between two comment lines (a comment is only a comment at the
 * start of a line) and `withoutMagicDns` takes that block out again.
 */
const BEGIN = '# kj-vpn begin'
const END = '# kj-vpn end'

export function withMagicDns(resolv: string, suffix?: string): string {
    const base = withoutMagicDns(resolv)
    const lines = [
        BEGIN,
        `nameserver ${MAGIC_DNS}`,
        ...(suffix && /^[a-z0-9.-]+$/i.test(suffix) ? [`search ${suffix}`] : []),
        'options timeout:1 attempts:2',
        END,
    ]
    return `${lines.join('\n')}\n${base}`
}

export function withoutMagicDns(resolv: string): string {
    const out: string[] = []
    let inside = false
    for (const l of resolv.split('\n')) {
        if (l === BEGIN) inside = true
        else if (l === END) inside = false
        else if (!inside) out.push(l)
    }
    return out.join('\n')
}

/** A tar with one regular file, for `putArchive` (root-owned, as the file it replaces). */
export function singleFileTar(name: string, content: string, mode = 0o644): Buffer {
    const body = Buffer.from(content, 'utf8')
    const header = Buffer.alloc(512, 0)
    const put = (s: string, off: number, len: number) => header.write(s, off, len, 'ascii')
    const oct = (n: number, len: number) => `${n.toString(8).padStart(len - 1, '0')}\0`
    put(name, 0, 100)
    put(oct(mode, 8), 100, 8)
    put(oct(0, 8), 108, 8)
    put(oct(0, 8), 116, 8)
    put(oct(body.length, 12), 124, 12)
    put(oct(Math.floor(Date.now() / 1000), 12), 136, 12)
    put('        ', 148, 8)
    put('0', 156, 1)
    put('ustar\0', 257, 6)
    put('00', 263, 2)
    let sum = 0
    for (const b of header) sum += b
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0)
    return Buffer.concat([header, body, pad, Buffer.alloc(1024, 0)])
}
