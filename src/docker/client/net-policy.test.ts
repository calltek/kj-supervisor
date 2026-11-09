import { describe, expect, test } from 'bun:test'

import {
    buildNetPolicyScript,
    CONV_CHAIN,
    defaultNetPolicy,
    inCidr,
    isCustomNetPolicy,
    type NetPolicy,
    type NetTargets,
    normalizeNetPolicy,
    WEB_CHAIN,
} from './net-policy'

const T: NetTargets = {
    nameservers: ['185.12.64.1', '2a01:4ff:ff00::add:1'],
    host_ips: ['203.0.113.7'],
    docker_nets: ['172.17.0.5/16'],
    gateway: '172.17.0.1',
    keychain_port: 9890,
    always: [{ ip: '160.79.104.10', port: 443 }],
}

/** The rules of one chain in one table, out of the heredoc that loads it. */
function rules(script: string, table: 'iptables' | 'ip6tables', chain: string): string[] {
    const m = new RegExp(`${table}-restore -w -n <<'R'\\n([\\s\\S]*?)\\nR`).exec(script)
    return (m?.[1] ?? '').split('\n').filter((l) => l.startsWith(`-A ${chain} `))
}

const policy = (p: Partial<NetPolicy>): NetPolicy => ({ ...defaultNetPolicy(), ...p })

describe('the floor', () => {
    test('comes before any list, and an allow list does not open it', () => {
        const script = buildNetPolicyScript(
            policy({ mode: 'allow', entries: [{ cidr: '172.17.0.0/16' }] }),
            T
        )
        const conv = rules(script, 'iptables', CONV_CHAIN)
        const floor = conv.indexOf(`-A ${CONV_CHAIN} -d 172.17.0.5/16 -j REJECT`)
        const opened = conv.indexOf(`-A ${CONV_CHAIN} -d 172.17.0.0/16 -j ACCEPT`)
        expect(floor).toBeGreaterThan(-1)
        expect(opened).toBeGreaterThan(floor)
        expect(conv).toContain(`-A ${CONV_CHAIN} -d 169.254.0.0/16 -j REJECT`)
        expect(conv).toContain(`-A ${CONV_CHAIN} -d 203.0.113.7 -j REJECT`)
    })

    test('a dedicated machine without lists leaves the conversations open', () => {
        const conv = rules(buildNetPolicyScript(defaultNetPolicy(), T), 'iptables', CONV_CHAIN)
        expect(conv.some((r) => r.includes('REJECT'))).toBe(false)
        expect(conv.at(-1)).toBe(`-A ${CONV_CHAIN} -j ACCEPT`)
    })

    test('a shared machine floors the conversations but leaves the LAN to the partner', () => {
        const shared = { ...T, shared: true }
        const conv = rules(buildNetPolicyScript(defaultNetPolicy(), shared), 'iptables', CONV_CHAIN)
        expect(conv).toContain(`-A ${CONV_CHAIN} -d 172.17.0.5/16 -j REJECT`)
        expect(conv).toContain(`-A ${CONV_CHAIN} -d 169.254.0.0/16 -j REJECT`)
        expect(conv).toContain(`-A ${CONV_CHAIN} -d 203.0.113.7 -j REJECT`)
        expect(conv.some((r) => r.includes('192.168.0.0/16'))).toBe(false)
        expect(conv.at(-1)).toBe(`-A ${CONV_CHAIN} -j ACCEPT`)
    })

    test('kj-keychain always goes first; a model endpoint goes before the floor', () => {
        const at = (t: NetTargets, p = defaultNetPolicy()) => {
            const conv = rules(buildNetPolicyScript(p, t), 'iptables', CONV_CHAIN)
            return {
                keychain: conv.indexOf(
                    `-A ${CONV_CHAIN} -d 172.17.0.1 -p tcp --dport 9890 -j ACCEPT`
                ),
                model: conv.indexOf(
                    `-A ${CONV_CHAIN} -d 160.79.104.10 -p tcp --dport 443 -j ACCEPT`
                ),
                floor: conv.indexOf(`-A ${CONV_CHAIN} -d 172.17.0.5/16 -j REJECT`),
            }
        }
        // A model on this LAN must keep answering a dedicated machine with a list.
        const dedicated = at(T, policy({ mode: 'deny', entries: [{ cidr: '198.51.100.0/24' }] }))
        expect(dedicated.keychain).toBeLessThan(dedicated.floor)
        expect(dedicated.model).toBeLessThan(dedicated.floor)
        const shared = at({ ...T, shared: true })
        expect(shared.keychain).toBeGreaterThan(-1)
        expect(shared.keychain).toBeLessThan(shared.floor)
        expect(shared.model).toBeLessThan(shared.floor)
    })

    test('on a shared machine an always endpoint opens the LAN and the host, never the metadata or another agent', () => {
        const t: NetTargets = {
            ...T,
            shared: true,
            always: [
                { ip: '10.0.0.5', port: 11434 },
                { ip: '172.17.0.1', port: 11434 },
                { ip: '172.17.0.9', port: 8080 },
                { ip: '169.254.169.254', port: 80 },
            ],
        }
        const conv = rules(buildNetPolicyScript(defaultNetPolicy(), t), 'iptables', CONV_CHAIN)
        const accept = (ip: string, port: number) =>
            conv.indexOf(`-A ${CONV_CHAIN} -d ${ip} -p tcp --dport ${port} -j ACCEPT`)
        expect(accept('10.0.0.5', 11434)).toBeGreaterThan(-1)
        expect(accept('172.17.0.1', 11434)).toBeGreaterThan(-1)
        expect(accept('172.17.0.9', 8080)).toBe(-1)
        expect(accept('169.254.169.254', 80)).toBe(-1)
        expect(conv.indexOf(`-A ${CONV_CHAIN} -d 169.254.0.0/16 -j REJECT`)).toBeLessThan(
            accept('10.0.0.5', 11434)
        )
    })

    test('on a shared machine the other metadata services and the tailnet stay closed, before any always', () => {
        const t: NetTargets = {
            ...T,
            shared: true,
            always: [
                { ip: '100.100.100.200', port: 80 },
                { ip: '168.63.129.16', port: 80 },
                { ip: 'fd7a:115c:a1e0::1', port: 22 },
                { ip: '::ffff:169.254.169.254', port: 80 },
                { ip: '10.0.0.7' },
            ],
        }
        const script = buildNetPolicyScript(defaultNetPolicy(), t)
        const conv = rules(script, 'iptables', CONV_CHAIN)
        const conv6 = rules(script, 'ip6tables', CONV_CHAIN)
        for (const n of ['100.64.0.0/10', '168.63.129.16/32'])
            expect(conv).toContain(`-A ${CONV_CHAIN} -d ${n} -j REJECT`)
        expect(conv6).toContain(`-A ${CONV_CHAIN} -d fd7a:115c:a1e0::/48 -j REJECT`)
        // None of them, nor an endpoint without a port, gets an ACCEPT.
        expect(
            conv.filter((r) => r.endsWith('-j ACCEPT') && /100.100|168.63|10.0.0.7/.test(r))
        ).toEqual([])
        expect(
            conv6
                .filter((r) => r.includes('fd7a') || r.includes('::ffff'))
                .every((r) => r.endsWith('REJECT'))
        ).toBe(true)
    })

    test('inCidr', () => {
        expect(inCidr('::ffff:169.254.169.254', '::ffff:0:0/96')).toBe(true)
        expect(inCidr('fe80::1%eth0', 'fe80::/10')).toBe(false)
        expect(inCidr('10.0.0.1', '1.2.3.4/')).toBe(false)
        expect(inCidr('10.0.0.1', '1.2.3.4/40')).toBe(false)
        expect(inCidr('172.17.0.9', '172.17.0.5/16')).toBe(true)
        expect(inCidr('172.18.0.9', '172.17.0.5/16')).toBe(false)
        expect(inCidr('169.254.169.254', '169.254.0.0/16')).toBe(true)
        expect(inCidr('fe80::1', 'fe80::/10')).toBe(true)
        expect(inCidr('10.0.0.1', 'fe80::/10')).toBe(false)
    })
})

describe('the verdict', () => {
    test('every chain ends in one, so a browser uid never falls into the conversations', () => {
        const script = buildNetPolicyScript(defaultNetPolicy(), T, 200001)
        expect(rules(script, 'iptables', CONV_CHAIN).at(-1)).toBe(`-A ${CONV_CHAIN} -j ACCEPT`)
        expect(rules(script, 'iptables', WEB_CHAIN).at(-1)).toBe(`-A ${WEB_CHAIN} -j ACCEPT`)
        expect(rules(script, 'ip6tables', WEB_CHAIN).at(-1)).toBe(`-A ${WEB_CHAIN} -j REJECT`)
        // The browser's jump is inserted on top; the conversations' appended.
        expect(script).toContain(`-I OUTPUT 1 -m owner --uid-owner 200001 -j ${WEB_CHAIN}`)
        expect(script).toContain(`-A OUTPUT -m owner --uid-owner 200000-299999 -j ${CONV_CHAIN}`)
    })

    test('an allow list rejects what it does not name; ports go per protocol', () => {
        const conv = rules(
            buildNetPolicyScript(
                policy({ mode: 'allow', entries: [{ cidr: '10.0.0.5', ports: [22] }] }),
                T
            ),
            'iptables',
            CONV_CHAIN
        )
        expect(conv).toContain(`-A ${CONV_CHAIN} -d 10.0.0.5 -p tcp --dport 22 -j ACCEPT`)
        expect(conv).toContain(`-A ${CONV_CHAIN} -d 10.0.0.5 -p udp --dport 22 -j ACCEPT`)
        expect(conv.at(-1)).toBe(`-A ${CONV_CHAIN} -j REJECT`)
    })

    test("by default the browser keeps today's fence: the private ranges cut", () => {
        const web = rules(
            buildNetPolicyScript(defaultNetPolicy(), T, 200001),
            'iptables',
            WEB_CHAIN
        )
        expect(web).toContain(`-A ${WEB_CHAIN} -d 10.0.0.0/8 -j REJECT`)
        expect(web).toContain(`-A ${WEB_CHAIN} -d 100.64.0.0/10 -j REJECT`)
        // …and the conversations keep their LAN, with the same (empty) list.
        const conv = rules(buildNetPolicyScript(defaultNetPolicy(), T), 'iptables', CONV_CHAIN)
        expect(conv).not.toContain(`-A ${CONV_CHAIN} -d 10.0.0.0/8 -j REJECT`)
    })

    test('one list for both: an allow list opens a private range to the browser on purpose', () => {
        const web = rules(
            buildNetPolicyScript(
                policy({ mode: 'allow', entries: [{ cidr: '10.20.0.0/16' }] }),
                T,
                7
            ),
            'iptables',
            WEB_CHAIN
        )
        expect(web).toContain(`-A ${WEB_CHAIN} -d 10.20.0.0/16 -j ACCEPT`)
        expect(web).not.toContain(`-A ${WEB_CHAIN} -d 10.0.0.0/8 -j REJECT`)
        expect(web.at(-1)).toBe(`-A ${WEB_CHAIN} -j REJECT`)
    })
})

describe("the control's policy", () => {
    test('only addresses and ports reach the shell', () => {
        const p = normalizeNetPolicy({
            mode: 'allow',
            entries: [
                { cidr: '1.1.1.1; reboot' },
                { cidr: '$(id)/8' },
                { cidr: '10.0.0.0/33' },
                { cidr: '10.0.0.0/8', ports: [22, '80; id', 70000] },
            ],
            always: [{ host: 'api.kujira.so', port: 443 }, { host: '`id`' }],
        })
        expect(p.entries).toEqual([{ cidr: '10.0.0.0/8', ports: [22] }])
        expect(p.always).toEqual([{ host: 'api.kujira.so', port: 443 }])
        const script = buildNetPolicyScript(p, {
            ...T,
            nameservers: ['1.1.1.1; reboot'],
            host_ips: ['`id`'],
        })
        expect(script).not.toMatch(/reboot|\$\(id\)|`id`/)
        expect(() => buildNetPolicyScript(p, T, 0)).toThrow()
    })

    test('a missing or broken policy is the default, and the default is not custom', () => {
        expect(normalizeNetPolicy(undefined)).toEqual(defaultNetPolicy())
        expect(normalizeNetPolicy({ mode: 'open' })).toEqual(defaultNetPolicy())
        expect(isCustomNetPolicy(defaultNetPolicy())).toBe(false)
        expect(isCustomNetPolicy(policy({ mode: 'allow', entries: [] }))).toBe(true)
    })
})
