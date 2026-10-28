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
 */
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

/** A chain of ours. The name carries a version: change the rules, bump it. */
export const FENCE_CHAIN = 'KJBROWSER2'

/** The helper image: alpine with iptables, built here once (`ensureFenceImage`). */
export const FENCE_IMAGE = 'kj-netfence:1'

/** IPv4 that is not the internet. */
export const FENCED_V4 = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '224.0.0.0/3',
]

export interface FenceTargets {
    /** The container's resolvers (its `/etc/resolv.conf`): DNS goes to these only. */
    nameservers: string[]
    /** The host's own addresses, cut on top of the ranges above. */
    host_ips: string[]
}

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

/** Only literal addresses ever reach the script: nothing else goes into a shell. */
const only = (ips: string[], family: 4 | 6) => ips.filter((ip) => isIP(ip) === family)

function chainRules(v6: boolean, t: FenceTargets): string {
    const family = v6 ? 6 : 4
    const dns = only(t.nameservers, family).flatMap((ip) =>
        ['udp', 'tcp'].map((p) => `-A ${FENCE_CHAIN} -d ${ip} -p ${p} --dport 53 -j RETURN`)
    )
    // IPv6: nothing but loopback and DNS. A page that has it falls back to
    // IPv4, and listing every local IPv6 range right is a game not worth it.
    const cut = v6
        ? [`-A ${FENCE_CHAIN} -j REJECT`]
        : [...FENCED_V4, ...only(t.host_ips, 4)].map((n) => `-A ${FENCE_CHAIN} -d ${n} -j REJECT`)
    return [
        '*filter',
        `:${FENCE_CHAIN} - [0:0]`,
        `-A ${FENCE_CHAIN} -o lo -j RETURN`,
        ...dns,
        ...cut,
        'COMMIT',
    ].join('\n')
}

/**
 * The helper's script: the chain, then the jump for this uid (once), then a
 * check that the jump is there. IPv6 only where the namespace has it: without
 * it there is no IPv6 traffic to cut, and no ip6tables to write to.
 */
export function buildBrowserFenceScript(uid: number, targets: FenceTargets): string {
    if (!Number.isInteger(uid) || uid <= 0) throw new Error(`bad browser uid: ${uid}`)
    const jump = `OUTPUT -m owner --uid-owner ${uid} -j ${FENCE_CHAIN}`
    return [
        'set -eu',
        'TABLES=iptables',
        `iptables-restore -w -n <<'R'\n${chainRules(false, targets)}\nR`,
        'if [ -e /proc/net/if_inet6 ]; then',
        '    TABLES="iptables ip6tables"',
        `    ip6tables-restore -w -n <<'R'\n${chainRules(true, targets)}\nR`,
        'fi',
        'for T in $TABLES; do',
        `    $T -w -C ${jump} 2>/dev/null || $T -w -I ${jump.replace('OUTPUT', 'OUTPUT 1')}`,
        `    $T -w -C ${jump}`,
        'done',
        'echo fenced',
    ].join('\n')
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
