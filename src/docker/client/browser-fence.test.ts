import { describe, expect, test } from 'bun:test'

import {
    buildBrowserFenceScript,
    FENCE_CHAIN,
    firstTarEntry,
    parseNameservers,
} from './browser-fence'

const T = { nameservers: ['185.12.64.1', '2a01:4ff:ff00::add:1'], host_ips: ['203.0.113.7'] }

/** The rules of one table, out of the heredoc that loads it. */
function rules(script: string, table: 'iptables' | 'ip6tables'): string[] {
    const m = new RegExp(`${table}-restore -w -n <<'R'\\n([\\s\\S]*?)\\nR`).exec(script)
    return (m?.[1] ?? '').split('\n').filter((l) => l.startsWith('-A '))
}

describe('the fence of a browser', () => {
    test('DNS goes to the container resolvers only, never to anything on port 53', () => {
        const v4 = rules(buildBrowserFenceScript(200001, T), 'iptables')
        const dns = v4.filter((l) => l.includes('--dport 53'))
        expect(dns).toHaveLength(2)
        expect(dns.every((l) => l.includes('-d 185.12.64.1 '))).toBe(true)
    })

    test("the host's own address is cut, on top of the private ranges", () => {
        const v4 = rules(buildBrowserFenceScript(200001, T), 'iptables')
        expect(v4).toContain(`-A ${FENCE_CHAIN} -d 203.0.113.7 -j REJECT`)
        expect(v4).toContain(`-A ${FENCE_CHAIN} -d 169.254.0.0/16 -j REJECT`)
        expect(v4[0]).toBe(`-A ${FENCE_CHAIN} -o lo -j RETURN`)
    })

    test('IPv6: loopback and its resolvers, then nothing', () => {
        const v6 = rules(buildBrowserFenceScript(200001, T), 'ip6tables')
        expect(v6.at(-1)).toBe(`-A ${FENCE_CHAIN} -j REJECT`)
        expect(v6.filter((l) => l.includes('RETURN'))).toHaveLength(3)
    })

    test('only addresses reach the shell', () => {
        const script = buildBrowserFenceScript(200001, {
            nameservers: ['1.1.1.1; reboot', '$(id)'],
            host_ips: ['`id`'],
        })
        expect(script).not.toMatch(/reboot|\$\(id\)|`id`/)
        expect(() => buildBrowserFenceScript(0, T)).toThrow()
        expect(() => buildBrowserFenceScript(1.5, T)).toThrow()
    })
})

test('nameservers out of a resolv.conf', () => {
    expect(
        parseNameservers('# x\nnameserver 127.0.0.11\nnameserver fe80::1%eth0\nnameserver nope\n')
    ).toEqual(['127.0.0.11', 'fe80::1'])
})

test('the file out of a one-file tar', () => {
    const body = Buffer.from('nameserver 1.1.1.1\n')
    const header = Buffer.alloc(512)
    header.write('resolv.conf', 0)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    const tar = Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)])
    expect(firstTarEntry(tar).toString()).toBe(body.toString())
})
