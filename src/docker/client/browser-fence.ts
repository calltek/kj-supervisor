/**
 * What a person's web browser in an agent may reach (kj-app
 * docs/navegador-integrado.md §9.5), enforced by the kernel of the agent's own
 * network namespace — the one rule the agent's request filter can't make.
 * That filter judges a URL before Chromium connects; this judges the address
 * it actually connects to. So it also holds against a name that resolves
 * public there and private here (DNS rebinding), against WebSockets (which
 * never reach the filter), and against a renderer taken over (it runs
 * without Chromium's sandbox).
 *
 * The network is the SERVER's, not the person's: the client's LAN, the
 * Docker gateway (this supervisor, the host), the cloud's metadata at
 * `169.254.169.254`, and the host's own public addresses — the ports Docker
 * publishes there answer from inside without crossing the cloud's firewall.
 * Cut. What stays: loopback (the dev server the agent started in its own
 * container) and DNS, to the container's own resolvers only.
 *
 * It applies to the browser's uid only (`-m owner`): the agent's own
 * conversations keep the network they had. Nothing in the container can lift
 * it: everything there runs as a uid other than root, which Docker starts with
 * no effective capabilities — not even where the container was given NET_ADMIN
 * for a VPN — and `no-new-privileges` stops it from gaining any.
 *
 * The chain is replaced atomically (`iptables-restore --noflush` flushes and
 * fills a chain it declares in one commit), so a second browser starting never
 * leaves the first one unfenced, even for a moment.
 *
 * The rules are the browser scope of the agent's network policy
 * (net-policy.ts, kj-app docs/red-por-agente.md §2) — by default, exactly
 * what this fence always cut. What stays here is the helper's plumbing.
 */
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

/** The helper image: alpine with iptables, built here once (`ensureFenceImage`). */
export const FENCE_IMAGE = 'kj-netfence:1'

/** The `nameserver` lines of a resolv.conf, keeping only real addresses. */
export function parseNameservers(resolvConf: string): string[] {
    const out: string[] = []
    for (const line of resolvConf.split('\n')) {
        const m = /^\s*nameserver\s+(\S+)/.exec(line)
        const ip = m?.[1]?.replace(/%.*$/, '')
        if (ip && isIP(ip) && !out.includes(ip)) out.push(ip)
    }
    return out
}

/** Where a container's resolvers are listed. */
export const RESOLV_CONF = '/etc/resolv.conf'

/** How long the helper may take; then the browser fails rather than wait. */
export const FENCE_TIMEOUT_MS = 30_000
/** The first build pulls alpine and installs iptables. */
export const FENCE_BUILD_TIMEOUT_MS = 180_000

/**
 * This host's own IPv4 addresses. The supervisor runs on the host's network
 * (`--network host`, the whole Linux fleet), so its interfaces are the host's:
 * the public one among them, where Docker publishes ports.
 */
export function hostAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((i) => !!i && i.family === 'IPv4' && !i.internal)
        .map((i) => (i as { address: string }).address)
}

/** The body of the first file in a tar (what `GET …/archive` of one file returns). */
export function firstTarEntry(tar: Buffer): Buffer {
    if (tar.length < 512) throw new Error('not a tar')
    const size = Number.parseInt(
        tar.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim(),
        8
    )
    if (!Number.isFinite(size) || size < 0 || 512 + size > tar.length)
        throw new Error('bad tar entry')
    return tar.subarray(512, 512 + size)
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000}s`)), ms)
    })
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}
