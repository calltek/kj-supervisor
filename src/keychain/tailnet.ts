/**
 * Tailscale nodes for `/connect`: one `tailscaled` per auth key, in userspace
 * networking (no TUN, no capability), with its SOCKS5 proxy on loopback. The
 * auth key comes from a credential resolved like any reference, so it lives
 * here and never in an agent's container.
 *
 * - State in memory (`--state=mem:`), which tailscaled registers as an
 *   EPHEMERAL node: a restart is a new node, and the old one leaves the
 *   tailnet on its own. The auth key has to be reusable for that.
 * - `--no-logs-no-support`: nothing about the connections leaves for
 *   Tailscale's log service.
 * - The key goes to `tailscale up` through a 0600 file in the tmpfs
 *   (`--auth-key=file:`), never on a command line, and is deleted after.
 * - A node unused for 30 minutes logs out and stops.
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

import type { KeychainLog } from './log'

const UP_TIMEOUT_MS = 45_000
const IDLE_STOP_MS = 30 * 60 * 1000

interface TailnetNode {
    socks_port: number
    dir: string
    socket: string
    daemon: ReturnType<typeof Bun.spawn>
    used_at: number
}

export interface TailnetPoolOptions {
    log: KeychainLog
    /** How this node shows up in the tailnet. */
    hostname?: string
    parent?: string
}

export class TailnetError extends Error {}

export class TailnetPool {
    private readonly nodes = new Map<string, Promise<TailnetNode>>()
    private readonly sweeper: ReturnType<typeof setInterval>

    constructor(private readonly opts: TailnetPoolOptions) {
        this.sweeper = setInterval(() => this.sweep(), 5 * 60 * 1000)
        this.sweeper.unref?.()
    }

    /** The SOCKS5 port of the node for this auth key, starting it if needed. */
    async socksFor(authKey: string): Promise<number> {
        const id = createHash('sha256').update(authKey).digest('hex').slice(0, 16)
        let node = this.nodes.get(id)
        if (!node) {
            node = this.start(id, authKey)
            this.nodes.set(id, node)
            node.catch(() => this.nodes.delete(id))
        }
        const ready = await node
        ready.used_at = Date.now()
        return ready.socks_port
    }

    private async start(id: string, authKey: string): Promise<TailnetNode> {
        const dir = mkdtempSync(`${this.opts.parent ?? '/tmp'}/ts-`)
        chmodSync(dir, 0o700)
        const socket = `${dir}/tailscaled.sock`
        const socks_port = freePort()
        const env = { HOME: dir, TS_LOGS_DIR: dir, PATH: process.env.PATH ?? '' }
        const daemon = Bun.spawn(
            [
                'tailscaled',
                '--tun=userspace-networking',
                '--state=mem:',
                `--statedir=${dir}`,
                `--socket=${socket}`,
                `--socks5-server=127.0.0.1:${socks_port}`,
                '--no-logs-no-support',
            ],
            { env, stdout: 'ignore', stderr: 'ignore' }
        )
        daemon.exited.then((code) => {
            this.opts.log('warn', 'tailnet node stopped', { node: id, code })
            this.nodes.delete(id)
            rmSync(dir, { recursive: true, force: true })
        })
        const keyFile = `${dir}/authkey`
        try {
            writeFileSync(keyFile, authKey, { mode: 0o600 })
            const up = Bun.spawn(
                [
                    'tailscale',
                    `--socket=${socket}`,
                    'up',
                    `--auth-key=file:${keyFile}`,
                    `--hostname=${this.opts.hostname ?? 'kj-keychain'}`,
                    '--timeout=40s',
                ],
                { env, stdout: 'ignore', stderr: 'pipe' }
            )
            const timer = setTimeout(() => up.kill(), UP_TIMEOUT_MS)
            const code = await up.exited
            clearTimeout(timer)
            if (code !== 0) {
                // tailscale's own words can quote the key in some versions: only
                // a short, key-free summary goes on.
                const err = (await new Response(up.stderr).text()).toLowerCase()
                daemon.kill()
                throw new TailnetError(
                    err.includes('invalid key') || err.includes('expired')
                        ? 'La auth key de Tailscale no es válida o ha caducado. Pide al operador una nueva en Credenciales.'
                        : 'No se ha podido entrar en la red de Tailscale con esa credencial.'
                )
            }
        } finally {
            rmSync(keyFile, { force: true })
        }
        this.opts.log('info', 'tailnet node up', { node: id })
        return { socks_port, dir, socket, daemon, used_at: Date.now() }
    }

    private sweep(): void {
        const idleSince = Date.now() - IDLE_STOP_MS
        for (const [id, pending] of this.nodes) {
            pending
                .then((node) => {
                    if (node.used_at > idleSince) return
                    this.nodes.delete(id)
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

    stop(): void {
        clearInterval(this.sweeper)
        for (const pending of this.nodes.values())
            pending.then((n) => n.daemon.kill()).catch(() => {})
        this.nodes.clear()
    }
}

/** A loopback port nobody is using right now. */
function freePort(): number {
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = probe.port
    probe.stop(true)
    return port
}
