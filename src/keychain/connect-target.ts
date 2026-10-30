/**
 * Where a VPN tunnel may go (`/connect`), and the SOCKS5 bytes to ask for it.
 * Pure: tested without a socket.
 *
 * The tunnel goes through the tailnet only: a Tailscale address
 * (100.64.0.0/10, fd7a:115c:a1e0::/48) or a MagicDNS name (one label, or under
 * `.ts.net`). tailscaled's SOCKS5 would otherwise dial anything else from this
 * container — the bridge, the host's network, the cloud's metadata — so
 * everything else is refused before asking. And, like an HTTP reference, the
 * host has to be one of the credential's destinations.
 */

import { isIP } from 'node:net'

import { parseIPv6 } from './addresses'
import { normalizeHost } from './sites'

export function isTailnetHost(raw: string): boolean {
    const host = normalizeHost(raw)
    if (!host || host === 'localhost') return false
    const family = isIP(host)
    if (family === 4) {
        const [a, b] = host.split('.').map(Number) as [number, number]
        return a === 100 && b >= 64 && b <= 127
    }
    if (family === 6) {
        const words = parseIPv6(host)
        return words !== null && words[0] === 0xfd7a && words[1] === 0x115c && words[2] === 0xa1e0
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host))
        return false
    return !host.includes('.') || host.endsWith('.ts.net')
}

export function parsePort(raw: string | null): number | null {
    if (!raw || !/^\d{1,5}$/.test(raw)) return null
    const port = Number(raw)
    return port >= 1 && port <= 65535 ? port : null
}

/** SOCKS5 greeting: version 5, one method, no authentication. */
export const SOCKS_GREETING = Buffer.from([5, 1, 0])

/** SOCKS5 CONNECT to host:port (an IP literal or a name tailscaled resolves). */
export function socksConnectRequest(host: string, port: number): Buffer {
    const h = normalizeHost(host)
    let address: Buffer
    if (isIP(h) === 4) {
        address = Buffer.from([1, ...h.split('.').map(Number)])
    } else if (isIP(h) === 6) {
        const words = parseIPv6(h) as number[]
        const bytes = Buffer.alloc(16)
        for (const [i, w] of words.entries()) bytes.writeUInt16BE(w, i * 2)
        address = Buffer.concat([Buffer.from([4]), bytes])
    } else {
        const name = Buffer.from(h, 'latin1')
        address = Buffer.concat([Buffer.from([3, name.length]), name])
    }
    const portBytes = Buffer.alloc(2)
    portBytes.writeUInt16BE(port)
    return Buffer.concat([Buffer.from([5, 1, 0]), address, portBytes])
}

/**
 * How many bytes the server's CONNECT reply takes, once enough has arrived to
 * know (null = wait for more). Throws with the SOCKS reply code on a refusal.
 */
export function socksReplyLength(buf: Buffer): number | null {
    if (buf.length < 5) return null
    if (buf[0] !== 5) throw new SocksError(-1)
    if (buf[1] !== 0) throw new SocksError(buf[1] as number)
    const atyp = buf[3]
    const length = atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? 7 + (buf[4] as number) : -1
    if (length < 0) throw new SocksError(-1)
    return buf.length >= length ? length : null
}

export class SocksError extends Error {
    constructor(readonly reply: number) {
        super(`socks reply ${reply}`)
    }
}

/** What a refused SOCKS CONNECT means, for the person reading the error. */
export function describeSocksReply(reply: number): string {
    switch (reply) {
        case 3:
        case 4:
            return 'la máquina no es alcanzable por la VPN (¿está encendida y conectada?)'
        case 5:
            return 'la máquina ha rechazado la conexión en ese puerto'
        case 6:
            return 'se ha agotado el tiempo al conectar'
        default:
            return 'la VPN no ha podido abrir la conexión'
    }
}
