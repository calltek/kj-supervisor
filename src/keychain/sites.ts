import type { KeychainSite } from './control-protocol'

export function normalizeHost(host: string): string {
    return host
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '')
}

/** `host === site.host`, or a subdomain of it when the site allows subdomains. */
export function hostMatchesSite(host: string, site: KeychainSite): boolean {
    const target = normalizeHost(host)
    const allowed = normalizeHost(site.host)
    if (!target || !allowed) return false
    if (target === allowed) return true
    return site.subdomains && target.endsWith(`.${allowed}`)
}

export function hostMatchesAnySite(host: string, sites: KeychainSite[]): boolean {
    return sites.some((site) => hostMatchesSite(host, site))
}

/**
 * «*.wallapop.com, api.stripe.com» — for error messages, spelled the way the
 * destination is written in the credential (the backend only sends
 * `subdomains` for a `*.dominio` destination).
 */
export function describeSites(sites: KeychainSite[]): string {
    return sites.map((site) => (site.subdomains ? `*.${site.host}` : site.host)).join(', ')
}
