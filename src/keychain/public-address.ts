/**
 * The public address kj-keychain connects to for a host: an IP literal must be
 * public itself; a name must resolve, and to public addresses only (any
 * private one among them refuses the lot). The caller connects to the address
 * returned, never re-resolving the name (DNS rebinding).
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isBlockedAddress } from './addresses'
import { KeychainError } from './errors'

export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>

export const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true, verbatim: true })

export interface PublicAddress {
    address: string
    family: number
    /** True when the host was already an IP. */
    literal: boolean
}

export async function resolvePublicAddress(
    hostname: string,
    lookup: LookupAll
): Promise<PublicAddress> {
    const blocked = () =>
        new KeychainError(
            'KEYCHAIN_PRIVATE_ADDRESS',
            `${hostname} apunta a una dirección privada o local. Las credenciales sólo se ` +
                'usan contra servicios públicos en internet.'
        )
    const family = isIP(hostname)
    if (family) {
        if (isBlockedAddress(hostname)) throw blocked()
        return { address: hostname, family, literal: true }
    }
    let addresses: { address: string; family: number }[]
    try {
        addresses = await lookup(hostname)
    } catch {
        addresses = []
    }
    if (!addresses.length) {
        throw new KeychainError(
            'KEYCHAIN_DNS_FAILED',
            `No se encuentra ${hostname}. Revisa que la dirección esté bien escrita.`
        )
    }
    if (addresses.some((a) => isBlockedAddress(a.address))) throw blocked()
    // IPv4 first: the default bridge has no IPv6 route, so an AAAA first would
    // fail even with a good A record behind it.
    const first = addresses.find((a) => a.family === 4) ?? addresses[0]
    if (!first) throw blocked()
    return { address: first.address, family: first.family, literal: false }
}
