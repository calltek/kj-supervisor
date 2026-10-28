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
 * Docker gateway (this supervisor, the host) and the cloud's metadata at
 * `169.254.169.254`. Cut. What stays: loopback (the dev server the agent
 * started in its own container) and DNS.
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

/** A chain of ours. The name carries a version: change the rules, bump it. */
export const FENCE_CHAIN = 'KJBROWSER1'

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

function chainRules(v6: boolean): string {
    const lines = [
        '*filter',
        `:${FENCE_CHAIN} - [0:0]`,
        `-A ${FENCE_CHAIN} -o lo -j RETURN`,
        `-A ${FENCE_CHAIN} -p udp --dport 53 -j RETURN`,
        `-A ${FENCE_CHAIN} -p tcp --dport 53 -j RETURN`,
        // IPv6: nothing but loopback and DNS. A page that has it falls back to
        // IPv4, and listing every local IPv6 range right is a game not worth it.
        ...(v6
            ? [`-A ${FENCE_CHAIN} -j REJECT`]
            : FENCED_V4.map((n) => `-A ${FENCE_CHAIN} -d ${n} -j REJECT`)),
        'COMMIT',
    ]
    return lines.join('\n')
}

/** The helper's script: the chain, then the jump for this uid (once). */
export function buildBrowserFenceScript(uid: number): string {
    if (!Number.isInteger(uid) || uid <= 0) throw new Error(`bad browser uid: ${uid}`)
    return [
        'set -eu',
        `iptables-restore -w -n <<'R'\n${chainRules(false)}\nR`,
        `ip6tables-restore -w -n <<'R'\n${chainRules(true)}\nR`,
        'for T in iptables ip6tables; do',
        `    $T -w -C OUTPUT -m owner --uid-owner ${uid} -j ${FENCE_CHAIN} 2>/dev/null ||`,
        `        $T -w -I OUTPUT 1 -m owner --uid-owner ${uid} -j ${FENCE_CHAIN}`,
        'done',
        'echo fenced',
    ].join('\n')
}
