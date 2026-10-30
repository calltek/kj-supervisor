/**
 * Tailscale nodes for `/connect`: one `tailscaled` per auth key, in userspace
 * networking (no TUN, no capability), with its SOCKS5 proxy on loopback. The
 * auth key comes from a credential resolved like any reference, so it lives
 * here and never in an agent's container.
 *
 * - State in memory (`--state=mem:`), which tailscaled registers as an
 *   EPHEMERAL node: a restart is a new node, and the old one leaves the
 *   tailnet on its own. The auth key has to be reusable for that.
 * - `--shields-up`: nothing from the tailnet gets in. In userspace mode
 *   tailscaled forwards what reaches its Tailscale IP to this container's
 *   loopback, where every node's SOCKS5 listens without authentication: any
 *   machine of that tailnet could otherwise go out from here, or through
 *   another customer's VPN (SOKI, #92).
 * - `--no-logs-no-support`: nothing about the connections leaves for
 *   Tailscale's log service.
 * - The key goes to `tailscale up` through a 0600 file in the tmpfs
 *   (`--auth-key=file:`), never on a command line, and is deleted after.
 * - A node with no tunnel open for 30 minutes logs out and stops. A tunnel
 *   counts as long as it is open, however quiet: an SSH session of hours is
 *   never cut by the sweep.
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

import { isTailnetHost } from './connect-target'
import type { KeychainLog } from './log'

const UP_TIMEOUT_MS = 45_000
const RESOLVE_TIMEOUT_MS = 5_000
const IDLE_STOP_MS = 30 * 60 * 1000

interface TailnetNode {
    socks_port: number
    dir: string
    socket: string
    daemon: ReturnType<typeof Bun.spawn>
    /** The node's own tailnet IPs. */
    self_ips: string[]
    /** Tunnels open through this node right now. */
    active: number
    /** When the last tunnel closed (or the node came up). */
    idle_since: number
}

/** A node in use: release it when the tunnel closes. */
export interface TailnetLease {
    socks_port: number
    /**
     * The node's own tailnet IPs. Never a tunnel destination: in userspace what
     * reaches them lands on this container's loopback, where every node's
     * SOCKS5 listens (SOKI, #93).
     */
    self_ips: string[]
    /** A MagicDNS name → its tailnet IP, or null when the tailnet has no such peer. */
    resolve: (name: string) => Promise<string | null>
    release: () => void
}

export interface TailnetPoolOptions {
    log: KeychainLog
    /** How this node shows up in the tailnet. */
    hostname?: string
    parent?: string
}

export class TailnetError extends Error {}

export function daemonArgs(dir: string, socket: string, socksPort: number): string[] {
    return [
        'tailscaled',
        '--tun=userspace-networking',
        '--state=mem:',
        `--statedir=${dir}`,
        `--socket=${socket}`,
        `--socks5-server=127.0.0.1:${socksPort}`,
        '--no-logs-no-support',
    ]
}

export function upArgs(socket: string, keyFile: string, hostname: string): string[] {
    return [
        'tailscale',
        `--socket=${socket}`,
        'up',
        `--auth-key=file:${keyFile}`,
        `--hostname=${hostname}`,
        // Outbound only: see the header.
        '--shields-up',
        '--timeout=40s',
    ]
}

export class TailnetPool {
    private readonly nodes = new Map<string, Promise<TailnetNode>>()
    private readonly sweeper: ReturnType<typeof setInterval>

    constructor(private readonly opts: TailnetPoolOptions) {
        this.sweeper = setInterval(() => this.sweep(), 5 * 60 * 1000)
        this.sweeper.unref?.()
    }

    /** The node for this auth key, started if needed, held until released. */
    async acquire(authKey: string): Promise<TailnetLease> {
        const id = createHash('sha256').update(authKey).digest('hex').slice(0, 16)
        let pending = this.nodes.get(id)
        if (!pending) {
            const started = this.start(id, authKey)
            pending = started
            this.nodes.set(id, started)
            started.catch(() => {
                if (this.nodes.get(id) === started) this.nodes.delete(id)
            })
        }
        const node = await pending
        node.active += 1
        let released = false
        return {
            socks_port: node.socks_port,
            self_ips: node.self_ips,
            resolve: (name) => resolveName(node.socket, name),
            release: () => {
                if (released) return
                released = true
                node.active -= 1
                if (node.active === 0) node.idle_since = Date.now()
            },
        }
    }

    private async start(id: string, authKey: string): Promise<TailnetNode> {
        const dir = mkdtempSync(`${this.opts.parent ?? '/tmp'}/ts-`)
        chmodSync(dir, 0o700)
        const socket = `${dir}/tailscaled.sock`
        const socks_port = freePort()
        const env = { HOME: dir, TS_LOGS_DIR: dir, PATH: process.env.PATH ?? '' }
        const daemon = Bun.spawn(daemonArgs(dir, socket, socks_port), {
            env,
            stdout: 'ignore',
            stderr: 'ignore',
        })
        const keyFile = `${dir}/authkey`
        let node: TailnetNode | null = null
        let self_ips: string[] = []
        daemon.exited.then((code) => {
            this.opts.log('warn', 'tailnet node stopped', { node: id, code })
            // Only this start's entry: after a sweep, a newer node for the
            // same key may already be there (Nova, #92).
            const mine = this.nodes.get(id)
            if (mine)
                mine.then(
                    (n) => {
                        if (n === node) this.nodes.delete(id)
                    },
                    () => {}
                )
            rmSync(dir, { recursive: true, force: true })
        })
        try {
            writeFileSync(keyFile, authKey, { mode: 0o600 })
            const up = Bun.spawn(upArgs(socket, keyFile, this.opts.hostname ?? 'kj-keychain'), {
                env,
                stdout: 'ignore',
                stderr: 'pipe',
            })
            const timer = setTimeout(() => up.kill(), UP_TIMEOUT_MS)
            const code = await up.exited
            clearTimeout(timer)
            if (code !== 0) {
                // tailscale's own words can quote the key in some versions: only
                // a short, key-free summary goes on.
                const err = (await new Response(up.stderr).text()).toLowerCase()
                throw new TailnetError(
                    err.includes('invalid key') || err.includes('expired')
                        ? 'La auth key de Tailscale no es válida, ha caducado o era de un solo uso y ya ' +
                              'se gastó. Pide al operador una reutilizable en Credenciales.'
                        : 'No se ha podido entrar en la red de Tailscale con esa credencial.'
                )
            }
            // Without its own IPs a tunnel back into the node can't be refused:
            // no node.
            self_ips = await tailnetIps(socket)
            if (!self_ips.length) {
                throw new TailnetError('No se ha podido entrar en la red de Tailscale con esa credencial.')
            }
        } catch (error) {
            daemon.kill()
            throw error
        } finally {
            rmSync(keyFile, { force: true })
        }
        this.opts.log('info', 'tailnet node up', { node: id })
        node = { socks_port, dir, socket, daemon, self_ips, active: 0, idle_since: Date.now() }
        return node
    }

    private sweep(): void {
        const idleSince = Date.now() - IDLE_STOP_MS
        for (const [id, pending] of this.nodes) {
            pending
                .then((node) => {
                    if (node.active > 0 || node.idle_since > idleSince) return
                    if (this.nodes.get(id) === pending) this.nodes.delete(id)
                    // Logout first: a node that only stops stays in the tailnet.
                    const logout = Bun.spawn(['tailscale', `--socket=${node.socket}`, 'logout'], {
                        stdout: 'ignore',
                        stderr: 'ignore',
                    })
                    const kill = () => node.daemon.kill()
                    setTimeout(kill, 10_000).unref?.()
                    logout.exited.then(kill, kill)
                })
                .catch(() => {})
        }
    }
}

/**
 * A MagicDNS name → the IP of that peer in the tailnet, asked of the node
 * itself. tailscaled's SOCKS5 would resolve anything else with the system DNS
 * and go out through the host (SOKI, #92), so the tunnel is opened to this IP,
 * never to the name.
 */
async function resolveName(socket: string, name: string): Promise<string | null> {
    return (await tailnetIps(socket, name))[0] ?? null
}

/** `tailscale ip [name]`: the tailnet IPs of that peer, or of the node itself. */
async function tailnetIps(socket: string, name?: string): Promise<string[]> {
    try {
        const p = Bun.spawn(['tailscale', `--socket=${socket}`, 'ip', ...(name ? [name] : [])], {
            stdout: 'pipe',
            stderr: 'ignore',
        })
        const timer = setTimeout(() => p.kill(), RESOLVE_TIMEOUT_MS)
        const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
        clearTimeout(timer)
        if (code !== 0) return []
        return out
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && /^[0-9a-f:.]+$/i.test(l) && isTailnetHost(l))
    } catch {
        return []
    }
}

/** A loopback port nobody is using right now. */
function freePort(): number {
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = probe.port
    probe.stop(true)
    return port
}
