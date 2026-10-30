/**
 * Which IP addresses kj-keychain refuses to talk to: anything that is not a
 * plain public unicast address. Private, loopback, link-local (and so the
 * 169.254.169.254 metadata service), CGNAT, multicast, reserved and
 * documentation ranges, plus IPv6 forms that embed an IPv4 (mapped, NAT64,
 * 6to4, Teredo, compatible), judged by the embedded address or refused.
 */

import { isIP } from 'node:net'

type Range4 = [base: number, bits: number]

const BLOCKED_V4: Range4[] = [
    [ip4('0.0.0.0'), 8], // "this network"
    [ip4('10.0.0.0'), 8],
    [ip4('100.64.0.0'), 10], // CGNAT
    [ip4('127.0.0.0'), 8],
    [ip4('169.254.0.0'), 16], // link-local, cloud metadata
    [ip4('172.16.0.0'), 12],
    [ip4('192.0.0.0'), 24], // IETF protocol assignments
    [ip4('192.0.2.0'), 24], // TEST-NET-1
    [ip4('192.88.99.0'), 24], // 6to4 relay anycast
    [ip4('192.168.0.0'), 16],
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
    // Unique local fc00::/7 (includes AWS's fd00:ec2::254 metadata)
    if ((w0 & 0xfe00) === 0xfc00) return true
    // Link-local fe80::/10 and deprecated site-local fec0::/10
    if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true
    // Multicast ff00::/8
    if ((w0 & 0xff00) === 0xff00) return true
    return false
}

/** True when kj-keychain must not connect to `address`. Unparseable counts as blocked. */
export function isBlockedAddress(address: string): boolean {
    const text = address.trim().replace(/^\[|\]$/g, '')
    const family = isIP(text.split('%')[0] ?? '')
    if (family === 4) return isBlockedV4Number(ip4(text))
    if (family === 6) {
        const words = parseIPv6(text)
        return words === null || isBlockedV6(words)
    }
    return true
}
