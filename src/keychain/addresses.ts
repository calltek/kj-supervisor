/**
 * Which IP addresses kj-keychain refuses to talk to: loopback, link-local (and
 * so the 169.254.169.254 metadata service), multicast, reserved and
 * documentation ranges, plus IPv6 forms that embed an IPv4 (mapped, NAT64,
 * 6to4, Teredo, compatible), judged by the embedded address or refused.
 *
 * Private networks (10/8, 172.16/12, 192.168/16, CGNAT, fc00::/7) are NOT
 * blocked: a credential only goes to the destinations its owner declared, and
 * a router, a NAS or a database on the customer's own network is a legitimate
 * one. Loopback stays closed because it is kj-keychain itself (its control
 * port), and the cloud metadata services stay closed in both families.
 */

import { isIP } from 'node:net'

import { inCidr } from '../docker/client/net-policy'

type Range4 = [base: number, bits: number]

const BLOCKED_V4: Range4[] = [
    [ip4('0.0.0.0'), 8], // "this network"
    [ip4('127.0.0.0'), 8],
    [ip4('169.254.0.0'), 16], // link-local, cloud metadata
    [ip4('192.0.0.0'), 24], // IETF protocol assignments
    [ip4('192.0.2.0'), 24], // TEST-NET-1
    [ip4('192.88.99.0'), 24], // 6to4 relay anycast
    [ip4('198.18.0.0'), 15], // benchmarking
    [ip4('198.51.100.0'), 24], // TEST-NET-2
    [ip4('203.0.113.0'), 24], // TEST-NET-3
    [ip4('224.0.0.0'), 4], // multicast
    [ip4('240.0.0.0'), 4], // reserved + broadcast
]

function ip4(text: string): number {
    const parts = text.split('.').map(Number)
    return (
        (((parts[0] ?? 0) << 24) |
            ((parts[1] ?? 0) << 16) |
            ((parts[2] ?? 0) << 8) |
            (parts[3] ?? 0)) >>>
        0
    )
}

function inRange4(value: number, [base, bits]: Range4): boolean {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (value & mask) >>> 0 === (base & mask) >>> 0
}

function isBlockedV4Number(value: number): boolean {
    return BLOCKED_V4.some((range) => inRange4(value, range))
}

/** IPv6 text → 8 hextets, or null. Accepts `::`, embedded dotted IPv4 and a zone id. */
export function parseIPv6(text: string): number[] | null {
    let s = text.trim().toLowerCase()
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
    const zone = s.indexOf('%')
    if (zone >= 0) s = s.slice(0, zone)
    if (isIP(s) !== 6) return null

    let tail: number[] = []
    const lastColon = s.lastIndexOf(':')
    const lastPart = s.slice(lastColon + 1)
    if (lastPart.includes('.')) {
        const v4 = ip4(lastPart)
        tail = [v4 >>> 16, v4 & 0xffff]
        s = `${s.slice(0, lastColon + 1)}${tail.length ? '0:0' : ''}`
    }

    const halves = s.split('::')
    const toHextets = (part: string) =>
        part === '' ? [] : part.split(':').map((h) => Number.parseInt(h, 16))
    let words: number[]
    if (halves.length === 2) {
        const head = toHextets(halves[0] ?? '')
        const rest = toHextets(halves[1] ?? '')
        words = [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest]
    } else {
        words = toHextets(s)
    }
    if (words.length !== 8 || words.some((w) => Number.isNaN(w))) return null
    if (tail.length) {
        words[6] = tail[0] ?? 0
        words[7] = tail[1] ?? 0
    }
    return words
}

function v4FromWords(hi: number, lo: number): number {
    return ((hi << 16) | lo) >>> 0
}

function isBlockedV6(words: number[]): boolean {
    const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words
    const firstSix = [w0, w1, w2, w3, w4, w5]
    // :: and ::1, and the deprecated IPv4-compatible ::a.b.c.d
    if (firstSix.every((w) => w === 0)) return true
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
        return isBlockedV4Number(v4FromWords(w6, w7))
    }
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) return true
    // NAT64 64:ff9b::/96 → judged by the embedded IPv4; 64:ff9b:1::/48 local-use
    if (w0 === 0x64 && w1 === 0xff9b) {
        if (w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
            return isBlockedV4Number(v4FromWords(w6, w7))
        }
        if (w2 === 1) return true
    }
    // 6to4 2002::/16 → embedded IPv4 in words 1-2
    if (w0 === 0x2002) return isBlockedV4Number(v4FromWords(w1, w2))
    // Teredo 2001::/32: the real endpoint is obfuscated; refuse.
    if (w0 === 0x2001 && w1 === 0) return true
    // Documentation 2001:db8::/32 and 3fff::/20
    if (w0 === 0x2001 && w1 === 0xdb8) return true
    if ((w0 & 0xfff0) === 0x3ff0) return true
    // Discard-only 100::/64
    if (w0 === 0x100 && w1 === 0 && w2 === 0 && w3 === 0) return true
    // AWS metadata over IPv6 (fd00:ec2::/32). The rest of fc00::/7 is a private
    // network and is allowed.
    if (w0 === 0xfd00 && w1 === 0x0ec2) return true
    // Link-local fe80::/10 and deprecated site-local fec0::/10
    if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true
    // Multicast ff00::/8
    if ((w0 & 0xff00) === 0xff00) return true
    return false
}

/**
 * The private ranges, closed until the supervisor says which networks to keep
 * closed (`setClosedNets`). kj-keychain boots strict: a supervisor that never
 * sends the list leaves it as it was before private networks were allowed.
 */
const STRICT_PRIVATE = [
    '10.0.0.0/8',
    '100.64.0.0/10',
    '172.16.0.0/12',
    '192.168.0.0/16',
    'fc00::/7',
]
/** Closed whatever the supervisor says: Alibaba's metadata service, inside CGNAT. */
const ALWAYS_CLOSED = ['100.100.100.200/32']

let closedNets: string[] | null = null

/**
 * The networks closed besides the base blocklist: the host's Docker networks
 * (other tenants' containers, kj-keychain's own control port), its gateway and,
 * on a shared machine, the tailnet and the host itself. `null` = not told yet:
 * every private range stays closed.
 */
export function setClosedNets(cidrs: string[] | null): void {
    closedNets = cidrs
}

/** The IPv4 an IPv6 address carries (mapped, NAT64, 6to4), as dotted text; else null. */
function embeddedV4(address: string): string | null {
    const words = parseIPv6(address)
    if (!words) return null
    const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words
    const dotted = (hi: number, lo: number) =>
        [hi >>> 8, hi & 0xff, lo >>> 8, lo & 0xff].join('.')
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
        return dotted(w6, w7)
    }
    if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
        return dotted(w6, w7)
    }
    if (w0 === 0x2002) return dotted(w1, w2)
    return null
}

function inClosedNets(address: string): boolean {
    const candidates = [address, embeddedV4(address)].filter((a): a is string => a !== null)
    const nets = [...ALWAYS_CLOSED, ...(closedNets ?? STRICT_PRIVATE)]
    return candidates.some((a) => nets.some((n) => inCidr(a, n)))
}

/**
 * An address on the customer's own network (RFC 1918, CGNAT, unique-local), as
 * opposed to the public internet. Only meaningful for an address that is not
 * blocked. There a service often has a self-signed certificate or no TLS at
 * all (a router, a NAS, a dev server), and the handler lets both through:
 * plain http and an unverified certificate are accepted only here, never
 * towards the internet.
 */
export function isPrivateLan(address: string): boolean {
    const text = address.trim().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
    const candidates = [text, embeddedV4(text)].filter((a): a is string => a !== null)
    return candidates.some((a) => STRICT_PRIVATE.some((n) => inCidr(a, n)))
}

/** True when kj-keychain must not connect to `address`. Unparseable counts as blocked. */
export function isBlockedAddress(address: string): boolean {
    return isBaseBlocked(address) || inClosedNets(address.trim().replace(/^[|]$/g, '').split('%')[0] ?? '')
}

function isBaseBlocked(address: string): boolean {
    const text = address.trim().replace(/^\[|\]$/g, '')
    const family = isIP(text.split('%')[0] ?? '')
    if (family === 4) return isBlockedV4Number(ip4(text))
    if (family === 6) {
        const words = parseIPv6(text)
        return words === null || isBlockedV6(words)
    }
    return true
}
