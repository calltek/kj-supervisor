/**
 * What an agent may reach (kj-app docs/red-por-agente.md §2): ONE list for
 * its conversations and the person's browser, enforced by the kernel of the
 * agent's own network namespace — the same
 * mechanism as the browser fence (browser-fence.ts), for every uid that is
 * not root.
 *
 * Two chains of ours, the same list in both:
 *  - CONVERSATIONS (`KJNET1-CONV`): the agent user (`bun`, 1000 — the
 *    launcher, its model proxy and the conversations that aren't isolated)
 *    and the isolated conversations (200000–299999);
 *  - the person's BROWSER (`KJNET1-WEB`): each browser uid, jumped to FIRST
 *    (browser uids live in the conversations' range).
 * Both chains end in a verdict (ACCEPT or REJECT), never fall through: a
 * browser uid must not end up in the conversations' chain too.
 *
 * In each chain, in order:
 *  1. loopback, DNS to the container's own resolvers;
 *  2. always allowed: kj-keychain on the bridge gateway, and the endpoints
 *     the control lists (the agent's model connections, Kujira's API) — the
 *     launcher's model proxy runs as `bun`, and a model on the host or on
 *     this LAN must keep answering;
 *  3. the FLOOR, no list opens it: link-local (the cloud's metadata), the
 *     container's Docker network (gateway, this supervisor, the host, every
 *     other agent) and the host's own addresses;
 *  4. the list: an allow list ACCEPTs what it names, a deny list REJECTs it;
 *  5. the browser only, with a deny list: the private ranges, REJECTed — it
 *     opens pages of third parties, and those must not reach the client's
 *     LAN or a tailnet. An allow list that names one opens it on purpose;
 *  6. the verdict: an allow list REJECTs the rest, a deny list ACCEPTs it.
 *
 * Root is never fenced: only this supervisor (exec -u 0) runs as root there.
 */
import { isIP } from 'node:net'

export type NetMode = 'allow' | 'deny'

/** One line of a list: an address or a CIDR, optionally some ports. */
export interface NetEntry {
    cidr: string
    ports?: number[]
}

/** An endpoint always reachable: a host (name or address) and maybe a port. */
export interface NetEndpoint {
    host: string
    port?: number
}

/** What the control sends for an agent. Anything missing takes the default. */
export interface NetPolicy {
    mode: NetMode
    entries: NetEntry[]
    always: NetEndpoint[]
}

/** The chains. The name carries a version: change the rules, bump it. */
export const CONV_CHAIN = 'KJNET1-CONV'
export const WEB_CHAIN = 'KJNET1-WEB'
/** Chains of earlier versions, whose jumps are removed when ours go in. */
export const OLD_CHAINS = ['KJBROWSER2']

/** The uids of the conversations scope: the agent user, and the isolated range. */
export const AGENT_UID = 1000
export const ISOLATED_UIDS = '200000-299999'

/** IPv4 that is not the internet: what a browser is kept out of by default. */
export const PRIVATE_V4 = [
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

const FLOOR_V4 = ['169.254.0.0/16']
const FLOOR_V6 = ['fe80::/10', '::ffff:0:0/96', 'fd00:ec2::254/128']

/** As things were before lists existed: conversations open, the browser off the private ranges. */
export function defaultNetPolicy(): NetPolicy {
    return { mode: 'deny', entries: [], always: [] }
}

const MAX_ENTRIES = 256
const MAX_PORTS = 16
const MAX_ENDPOINTS = 64
const HOSTNAME =
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

/** `1.2.3.4`, `1.2.3.0/24`, `2001:db8::/32` → its family, or 0. */
export function cidrFamily(cidr: string): 0 | 4 | 6 {
    const [ip, bits, ...rest] = cidr.split('/')
    if (!ip || rest.length) return 0
    const family = isIP(ip)
    if (family !== 4 && family !== 6) return 0
    if (bits === undefined) return family
    if (!/^\d{1,3}$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)) return 0
    return family
}

const validPort = (p: unknown): p is number =>
    typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535

function entriesOf(raw: unknown): NetEntry[] {
    const entries: NetEntry[] = []
    for (const e of Array.isArray(raw) ? raw.slice(0, MAX_ENTRIES) : []) {
        const cidr = (e as { cidr?: unknown })?.cidr
        if (typeof cidr !== 'string' || !cidrFamily(cidr)) continue
        const ports = (e as { ports?: unknown }).ports
        const valid = Array.isArray(ports) ? [...new Set(ports.filter(validPort))] : []
        entries.push(valid.length ? { cidr, ports: valid.slice(0, MAX_PORTS) } : { cidr })
    }
    return entries
}

/**
 * The control's policy, kept to what can be written as rules: addresses that
 * parse, ports in range, names that are names. Nothing else ever reaches the
 * helper's shell. A missing or malformed mode is the default policy.
 */
export function normalizeNetPolicy(raw: unknown): NetPolicy {
    const d = defaultNetPolicy()
    if (!raw || typeof raw !== 'object') return d
    const r = raw as { mode?: unknown; entries?: unknown; always?: unknown }
    const always: NetEndpoint[] = []
    for (const e of Array.isArray(r.always) ? r.always.slice(0, MAX_ENDPOINTS) : []) {
        const host = (e as { host?: unknown })?.host
        if (typeof host !== 'string' || !(isIP(host) || HOSTNAME.test(host))) continue
        const port = (e as { port?: unknown }).port
        always.push(validPort(port) ? { host, port } : { host })
    }
    if (r.mode !== 'allow' && r.mode !== 'deny') return { ...d, always }
    return { mode: r.mode, entries: entriesOf(r.entries), always }
}

/** Is this policy anything other than the default? Then failing to apply it stops the agent. */
export function isCustomNetPolicy(p: NetPolicy): boolean {
    const n = normalizeNetPolicy(p)
    return n.mode !== 'deny' || n.entries.length > 0
}

/** The endpoints of `always` with their names resolved: what goes in the rules. */
export interface ResolvedEndpoint {
    ip: string
    port?: number
}

/** Where the agent is, read off its container and this host. */
export interface NetTargets {
    /** The container's resolvers: DNS goes to these only. */
    nameservers: string[]
    /** The host's own addresses. */
    host_ips: string[]
    /** The container's Docker network, as CIDRs (gateway, supervisor, other agents). */
    docker_nets: string[]
    /** The bridge gateway, where kj-keychain listens for the agents. */
    gateway: string | null
    keychain_port: number
    always: ResolvedEndpoint[]
}

const only = (ips: string[], family: 4 | 6) => ips.filter((ip) => cidrFamily(ip) === family)

function portRules(head: string, ports: number[] | undefined, verdict: string): string[] {
    if (!ports?.length) return [`${head} -j ${verdict}`]
    return ports.flatMap((p) =>
        ['tcp', 'udp'].map((proto) => `${head} -p ${proto} --dport ${p} -j ${verdict}`)
    )
}

/** One chain's rules, for one family. The browser has no IPv6 but loopback and DNS. */
export function chainRules(
    chain: string,
    scope: Pick<NetPolicy, 'mode' | 'entries'>,
    t: NetTargets,
    family: 4 | 6,
    browser = false
): string[] {
    const a = `-A ${chain}`
    const out = [`${a} -o lo -j ACCEPT`]
    for (const ip of only(t.nameservers, family))
        for (const p of ['udp', 'tcp']) out.push(`${a} -d ${ip} -p ${p} --dport 53 -j ACCEPT`)
    if (family === 6 && browser) {
        out.push(`${a} -j REJECT`)
        return out
    }
    for (const e of t.always)
        if (cidrFamily(e.ip) === family)
            out.push(...portRules(`${a} -d ${e.ip}`, e.port ? [e.port] : undefined, 'ACCEPT'))
    if (family === 4 && t.gateway && cidrFamily(t.gateway) === 4)
        out.push(`${a} -d ${t.gateway} -p tcp --dport ${t.keychain_port} -j ACCEPT`)
    const floor =
        family === 4
            ? [...FLOOR_V4, ...only(t.docker_nets, 4), ...only(t.host_ips, 4)]
            : [...FLOOR_V6, ...only(t.docker_nets, 6), ...only(t.host_ips, 6)]
    for (const n of floor) out.push(`${a} -d ${n} -j REJECT`)
    const hit = scope.mode === 'allow' ? 'ACCEPT' : 'REJECT'
    for (const e of scope.entries)
        if (cidrFamily(e.cidr) === family) out.push(...portRules(`${a} -d ${e.cidr}`, e.ports, hit))
    if (browser && family === 4 && scope.mode === 'deny')
        for (const n of PRIVATE_V4) out.push(`${a} -d ${n} -j REJECT`)
    out.push(`${a} -j ${scope.mode === 'allow' ? 'REJECT' : 'ACCEPT'}`)
    return out
}

function table(policy: NetPolicy, t: NetTargets, family: 4 | 6): string {
    return [
        '*filter',
        `:${CONV_CHAIN} - [0:0]`,
        `:${WEB_CHAIN} - [0:0]`,
        ...chainRules(CONV_CHAIN, policy, t, family),
        ...chainRules(WEB_CHAIN, policy, t, family, true),
        'COMMIT',
    ].join('\n')
}

/**
 * The helper's script: both chains replaced in one commit per family, then
 * the jumps — a browser uid's first, then the conversations' — each added
 * once, then the old version's jumps removed. Ends with `netpolicy` only if
 * every jump is in place.
 */
export function buildNetPolicyScript(
    policy: NetPolicy,
    t: NetTargets,
    browserUid?: number
): string {
    if (browserUid !== undefined && (!Number.isInteger(browserUid) || browserUid <= 0))
        throw new Error(`bad browser uid: ${browserUid}`)
    const p = normalizeNetPolicy(policy)
    const jumps = [
        `OUTPUT -m owner --uid-owner ${AGENT_UID} -j ${CONV_CHAIN}`,
        `OUTPUT -m owner --uid-owner ${ISOLATED_UIDS} -j ${CONV_CHAIN}`,
    ]
    const web = browserUid ? `OUTPUT -m owner --uid-owner ${browserUid} -j ${WEB_CHAIN}` : null
    const old = OLD_CHAINS.join('|')
    return [
        'set -eu',
        'TABLES=iptables',
        `iptables-restore -w -n <<'R'\n${table(p, t, 4)}\nR`,
        'if [ -e /proc/net/if_inet6 ]; then',
        '    TABLES="iptables ip6tables"',
        `    ip6tables-restore -w -n <<'R'\n${table(p, t, 6)}\nR`,
        'fi',
        'for T in $TABLES; do',
        // Appended, so a browser's jump inserted at the top stays first.
        ...jumps.map((j) => `    $T -w -C ${j} 2>/dev/null || $T -w -A ${j}`),
        ...(web
            ? [`    $T -w -C ${web} 2>/dev/null || $T -w -I ${web.replace('OUTPUT', 'OUTPUT 1')}`]
            : []),
        ...jumps.map((j) => `    $T -w -C ${j}`),
        ...(web ? [`    $T -w -C ${web}`] : []),
        `    $T -w -S OUTPUT | sed -n -E 's/^-A (.* -j (${old}))$/\\1/p' | while read -r R; do $T -w -D $R; done`,
        'done',
        'echo netpolicy',
    ].join('\n')
}
