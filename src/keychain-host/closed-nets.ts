/**
 * The networks kj-keychain is told to keep closed (`closed_nets` on the
 * control channel, applied by `keychain/addresses.ts`).
 *
 * kj-keychain is ONE container per supervisor, on the default bridge, serving
 * the agents of every tenant, and it connects wherever a credential's owner
 * points it. The iptables floor (net-policy.ts) fences each agent's own
 * namespace and does not cover kj-keychain, so what it must not reach is
 * listed here and handed to it:
 *
 * - **This host's Docker networks** (docker0, kj-keychain-net, any other):
 *   other tenants' containers and kj-keychain's own control port.
 * - **The bridge gateway.**
 * - **On a shared machine** also what net-policy.ts closes for the agents of a
 *   shared one: the tailnet and the cloud metadata addresses that don't live
 *   in link-local, and the host's own addresses.
 *
 * What stays open is the customer's real LAN: a router, a NAS, a database.
 */

import { cidrFamily, SHARED_CLOSED_V4, SHARED_CLOSED_V6 } from '../docker/client/net-policy'

export interface ClosedNetFacts {
    /** IPAM subnets of every Docker network of this host. */
    subnets: string[]
    /** The host's own addresses. */
    host_ips: string[]
    /** A shared machine (tenancy.ts). */
    shared: boolean
}

function hostCidr(ip: string): string | null {
    const family = cidrFamily(ip)
    if (family === 0) return null
    return ip.includes('/') ? ip : `${ip}/${family === 4 ? 32 : 128}`
}

export function buildClosedNets(facts: ClosedNetFacts, gateway: string | null): string[] {
    const out = new Set<string>()
    for (const subnet of facts.subnets) if (cidrFamily(subnet) !== 0) out.add(subnet)
    const gw = gateway ? hostCidr(gateway) : null
    if (gw) out.add(gw)
    if (facts.shared) {
        for (const cidr of [...SHARED_CLOSED_V4, ...SHARED_CLOSED_V6]) out.add(cidr)
        for (const ip of facts.host_ips) {
            const cidr = hostCidr(ip)
            if (cidr) out.add(cidr)
        }
    }
    return [...out]
}
