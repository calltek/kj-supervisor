import { describe, expect, test } from 'bun:test'

import { KJLogger } from '../../logger'
import { defaultNetPolicy, type NetPolicy, normalizeNetPolicy } from './net-policy'
import { NetPolicyService } from './net-policy-service'

function fake(shared = false) {
    const policies = new Map<number, NetPolicy>()
    const applied: string[] = []
    const docker = {
        isShared: () => shared,
        netPolicyOf: (id: number) => policies.get(id) ?? defaultNetPolicy(),
        setNetPolicy: (id: number, raw: unknown) => {
            const p = normalizeNetPolicy(raw)
            policies.set(id, p)
            return p
        },
        applyNetPolicy: async (cid: string) => {
            applied.push(cid)
        },
        stopContainer: async () => undefined,
    }
    return { svc: new NetPolicyService(docker as never, KJLogger.create('error')), applied }
}

const list = { mode: 'deny', entries: [{ cidr: '198.51.100.0/24' }], always: [] }

describe('NetPolicyService.enforce', () => {
    test('a dedicated machine with no list writes nothing', async () => {
        const { svc, applied } = fake()
        await svc.enforce(1, 'c1')
        await svc.enforce(1, 'c1', defaultNetPolicy())
        expect(applied).toEqual([])
    })

    test('going back to the default from a list rewrites the rules once', async () => {
        const { svc, applied } = fake()
        await svc.enforce(1, 'c1', list)
        await svc.enforce(1, 'c1', defaultNetPolicy())
        await svc.enforce(1, 'c1', defaultNetPolicy())
        expect(applied).toEqual(['c1', 'c1'])
    })

    test('a shared machine always writes', async () => {
        const { svc, applied } = fake(true)
        await svc.enforce(1, 'c1')
        expect(applied).toEqual(['c1'])
    })
})
