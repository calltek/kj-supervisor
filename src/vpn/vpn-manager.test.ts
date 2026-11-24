import { describe, expect, test } from 'bun:test'

import type { KJLogger } from '../logger'
import { VpnManager, type VpnDocker } from './vpn-manager'

const silent = {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    child: () => silent,
} as unknown as KJLogger

/** A Docker that only keeps the uids let through the tunnel and counts rule writes. */
function fakeDocker() {
    const allowed = new Map<number, Set<number>>()
    let policyWrites = 0
    const docker = {
        allowVpnUid: (agent_id: number, uid: number) => {
            const set = allowed.get(agent_id) ?? new Set<number>()
            if (set.has(uid)) return false
            set.add(uid)
            allowed.set(agent_id, set)
            return true
        },
        applyNetPolicy: async () => {
            policyWrites++
        },
        forgetVpnUids: (agent_id: number) => allowed.delete(agent_id),
    } as unknown as VpnDocker
    return { docker, allowed, writes: () => policyWrites }
}

describe('who may use the tunnel', () => {
    test("a client's conversation never gets its uid through", async () => {
        const d = fakeDocker()
        const vpn = new VpnManager({ docker: d.docker, push: () => undefined, logger: silent })
        vpn.want(7, 'kujira-gaz-7')
        vpn.markSession(7, 's-client', true)
        await vpn.onUid(7, 'c1', 's-client', 200001)
        expect(d.allowed.get(7)?.has(200001) ?? false).toBe(false)
    })

    test('an unknown session stays out (nothing said = not the team)', async () => {
        const d = fakeDocker()
        const vpn = new VpnManager({ docker: d.docker, push: () => undefined, logger: silent })
        vpn.want(7, 'kujira-gaz-7')
        await vpn.onUid(7, 'c1', 's-never-seen', 200002)
        expect(d.allowed.get(7)?.has(200002) ?? false).toBe(false)
    })

    test("the team's isolated conversation and a person's browser get through", async () => {
        const d = fakeDocker()
        const vpn = new VpnManager({ docker: d.docker, push: () => undefined, logger: silent })
        vpn.want(7, 'kujira-gaz-7')
        vpn.markSession(7, 's-team', false)
        await vpn.onUid(7, 'c1', 's-team', 200003)
        await vpn.onUid(7, 'c1', 'kj-browser-5', 200004, true)
        expect([...(d.allowed.get(7) ?? [])].sort()).toEqual([200003, 200004])
        expect(d.writes()).toBe(2)
    })

    test('a session seen once as a client stays one', async () => {
        const d = fakeDocker()
        const vpn = new VpnManager({ docker: d.docker, push: () => undefined, logger: silent })
        vpn.want(7, 'kujira-gaz-7')
        vpn.markSession(7, 's', true)
        vpn.markSession(7, 's', false)
        await vpn.onUid(7, 'c1', 's', 200005)
        expect(d.allowed.get(7)?.has(200005) ?? false).toBe(false)
    })
})
