import { describe, expect, test } from 'bun:test'

import {
    buildNetPolicyScript,
    CONV_CHAIN,
    defaultNetPolicy,
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
            policy({ conversations: { mode: 'allow', entries: [{ cidr: '172.17.0.0/16' }] } }),
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

    test('lets kj-keychain and the always-allowed endpoints through first', () => {
        const conv = rules(buildNetPolicyScript(defaultNetPolicy(), T), 'iptables', CONV_CHAIN)
        const keychain = conv.indexOf(
            `-A ${CONV_CHAIN} -d 172.17.0.1 -p tcp --dport 9890 -j ACCEPT`
        )
        const model = conv.indexOf(`-A ${CONV_CHAIN} -d 160.79.104.10 -p tcp --dport 443 -j ACCEPT`)
        const floor = conv.indexOf(`-A ${CONV_CHAIN} -d 172.17.0.5/16 -j REJECT`)
        expect(keychain).toBeGreaterThan(-1)
        expect(model).toBeGreaterThan(-1)
        expect(keychain).toBeLessThan(floor)
        expect(model).toBeLessThan(floor)
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
                policy({
                    conversations: { mode: 'allow', entries: [{ cidr: '10.0.0.5', ports: [22] }] },
                }),
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
    })
})

describe("the control's policy", () => {
    test('only addresses and ports reach the shell', () => {
        const p = normalizeNetPolicy({
            conversations: {
                mode: 'allow',
                entries: [
                    { cidr: '1.1.1.1; reboot' },
                    { cidr: '$(id)/8' },
                    { cidr: '10.0.0.0/33' },
                    { cidr: '10.0.0.0/8', ports: [22, '80; id', 70000] },
                ],
            },
            always: [{ host: 'api.kujira.so', port: 443 }, { host: '`id`' }],
        })
        expect(p.conversations.entries).toEqual([{ cidr: '10.0.0.0/8', ports: [22] }])
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
        expect(normalizeNetPolicy({ conversations: { mode: 'open' } })).toEqual(defaultNetPolicy())
        expect(isCustomNetPolicy(defaultNetPolicy())).toBe(false)
        expect(isCustomNetPolicy(policy({ conversations: { mode: 'allow', entries: [] } }))).toBe(
            true
        )
    })
})
