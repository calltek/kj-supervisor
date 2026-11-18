import { describe, expect, test } from 'bun:test'

import {
    buildVpnContainerSpec,
    parseProfiles,
    parseTailscaleStatus,
    switchCommand,
    upCommand,
    withMagicDns,
    withoutMagicDns,
} from './vpn-spec'

describe('the sidecar', () => {
    test('shares only the network, with NET_ADMIN and the tun, and never the kj-agent label', () => {
        const spec = buildVpnContainerSpec({ agent_id: 7, agent_container_id: 'abc', image: 'img' })
        expect(spec.HostConfig?.NetworkMode).toBe('container:abc')
        expect(spec.HostConfig?.CapDrop).toEqual(['ALL'])
        expect(spec.HostConfig?.CapAdd).toEqual(['NET_ADMIN'])
        expect(spec.HostConfig?.Privileged).toBeUndefined()
        expect(spec.HostConfig?.Binds).toBeUndefined()
        expect(spec.HostConfig?.Mounts?.map((m) => m.Source)).toEqual(['kj-agent-7-vpn'])
        expect(Object.keys(spec.Labels ?? {})).not.toContain('kj-agent')
    })

    test('a hostname that could be read as a flag is refused', () => {
        expect(() => upCommand('--authkey=x')).toThrow()
        expect(() => upCommand('Kujira Bot')).toThrow()
        expect(upCommand('kujira-gaz-48')).toContain('--hostname=kujira-gaz-48')
    })
})

describe('tailscale status', () => {
    test('a login in progress gives its URL and nothing else', () => {
        const r = parseTailscaleStatus(
            JSON.stringify({
                BackendState: 'NeedsLogin',
                AuthURL: 'https://login.tailscale.com/a/x',
            })
        )
        expect(r).toEqual({ state: 'needs_login', auth_url: 'https://login.tailscale.com/a/x' })
    })

    test('connected: IP, node, tailnet and account', () => {
        const r = parseTailscaleStatus(
            JSON.stringify({
                BackendState: 'Running',
                Self: {
                    HostName: 'kujira-gaz-48',
                    TailscaleIPs: ['fd7a:115c:a1e0::1', '100.101.102.103'],
                    KeyExpiry: '2027-05-16T10:00:00Z',
                    UserID: 5,
                },
                CurrentTailnet: {
                    Name: 'example.com',
                    MagicDNSSuffix: 'tail1.ts.net',
                    MagicDNSEnabled: true,
                },
                User: { '5': { LoginName: 'someone@example.com' } },
            })
        )
        expect(r.state).toBe('connected')
        expect(r.ip).toBe('100.101.102.103')
        expect(r.login).toBe('someone@example.com')
        expect(r.magic_dns_suffix).toBe('tail1.ts.net')
    })

    test('logged out after having a key reads as expired; garbage as starting', () => {
        expect(
            parseTailscaleStatus(
                JSON.stringify({
                    BackendState: 'NeedsLogin',
                    Self: { KeyExpiry: '2026-01-01T00:00:00Z' },
                })
            ).state
        ).toBe('expired')
        expect(parseTailscaleStatus('not json').state).toBe('starting')
    })
})

describe('MagicDNS in the agent resolver', () => {
    test('goes first and comes out clean', () => {
        const original = 'nameserver 185.12.64.1\nsearch example.org\n'
        const withIt = withMagicDns(original, 'tail1.ts.net')
        expect(withIt.split('\n').find((l) => l.startsWith('nameserver'))).toBe(
            'nameserver 100.100.100.100'
        )
        expect(withMagicDns(withIt, 'tail1.ts.net')).toBe(withIt)
        expect(withoutMagicDns(withIt)).toBe(original)
    })
})

describe('saved accounts', () => {
    test('reads tailscale switch --list, the active one marked', () => {
        const raw = [
            'ID    Tailnet           Account',
            'a1b2  example.com       it@example.com*',
            'c3d4  other.org         ops@other.org',
            'e5f6                    new@example.net',
        ].join('\n')
        expect(parseProfiles(raw)).toEqual([
            { id: 'a1b2', tailnet: 'example.com', account: 'it@example.com', active: true },
            { id: 'c3d4', tailnet: 'other.org', account: 'ops@other.org', active: false },
            { id: 'e5f6', account: 'new@example.net', active: false },
        ])
    })

    test('a profile id that could be read as a flag is refused', () => {
        expect(() => switchCommand('--help')).toThrow()
        expect(switchCommand('a1b2').at(-1)).toBe('a1b2')
    })
})
