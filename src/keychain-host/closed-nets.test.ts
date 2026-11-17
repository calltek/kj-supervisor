import { describe, expect, test } from 'bun:test'

import { buildClosedNets } from './closed-nets'

const facts = {
    subnets: ['172.17.0.0/16', '172.30.0.0/16', 'basura'],
    host_ips: ['203.0.113.7', 'fe80::1'],
    shared: false,
}

describe('buildClosedNets', () => {
    test('dedicated: the Docker networks and the gateway, nothing else', () => {
        expect(buildClosedNets(facts, '172.17.0.1')).toEqual([
            '172.17.0.0/16',
            '172.30.0.0/16',
            '172.17.0.1/32',
        ])
    })

    test('a gateway that is not an IP is ignored', () => {
        expect(buildClosedNets(facts, 'nope')).toEqual(['172.17.0.0/16', '172.30.0.0/16'])
        expect(buildClosedNets(facts, null)).toEqual(['172.17.0.0/16', '172.30.0.0/16'])
    })

    test('shared: also the tailnet, the cloud metadata and the host itself', () => {
        const nets = buildClosedNets({ ...facts, shared: true }, '172.17.0.1')
        expect(nets).toEqual(
            expect.arrayContaining([
                '172.17.0.0/16',
                '100.64.0.0/10',
                '168.63.129.16/32',
                'fd7a:115c:a1e0::/48',
                '203.0.113.7/32',
                'fe80::1/128',
            ])
        )
    })
})
