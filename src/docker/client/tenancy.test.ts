import { describe, expect, it } from 'bun:test'
import {
    buildQuotaScript,
    normalizeTenancy,
    quotaProjectId,
    sharedReadiness,
    sharedSpawnRefusal,
} from './tenancy'

const ok = {
    image_tag: 'ghcr.io/calltek/kj-agent-base:1.2.3-isolation',
    memory_mb: 2048,
    cpu: 1,
    isolation_mode: 'exec' as const,
    disk_quota: true,
}

describe('tenancy', () => {
    it('anything but SHARED is dedicated', () => {
        expect(normalizeTenancy('SHARED')).toBe('shared')
        expect(normalizeTenancy(undefined)).toBe('dedicated')
        expect(normalizeTenancy('shared ')).toBe('dedicated')
    })

    it('a shared machine refuses what would let one tenant hurt another', () => {
        expect(sharedSpawnRefusal(ok)).toBeNull()
        expect(sharedSpawnRefusal({ ...ok, memory_mb: 0 })).toBe('shared_no_limits')
        expect(sharedSpawnRefusal({ ...ok, cpu: 0 })).toBe('shared_no_limits')
        expect(sharedSpawnRefusal({ ...ok, network_privileged: true })).toBe(
            'shared_network_privileged'
        )
        expect(sharedSpawnRefusal({ ...ok, isolation_mode: 'root' })).toBe('shared_root_isolation')
        expect(sharedSpawnRefusal({ ...ok, image_tag: 'evil/agent:latest' })).toBe(
            'shared_foreign_image'
        )
        expect(sharedSpawnRefusal({ ...ok, image_tag: 'ghcr.io/calltek.evil/x:1' })).toBe(
            'shared_foreign_image'
        )
        expect(sharedSpawnRefusal({ ...ok, disk_quota: false })).toBe('shared_no_disk_quota')
    })

    it('readiness lists what is missing', () => {
        expect(
            sharedReadiness({ userns_remap: true, disk_quota: true, network_rules: true })
        ).toEqual({ ready: true, missing: [] })
        expect(
            sharedReadiness({ userns_remap: false, disk_quota: true, network_rules: false })
        ).toEqual({ ready: false, missing: ['userns_remap', 'network_rules'] })
    })

    it('the quota script only takes plain paths', () => {
        expect(quotaProjectId(7)).toBe(1_000_007)
        expect(() => quotaProjectId(0)).toThrow()
        const s = buildQuotaScript(
            '/var/lib/docker',
            '/var/lib/docker/volumes/kj-agent-7-home/_data',
            1_000_007,
            20
        )
        expect(s).toContain('limit -p bhard=20g 1000007')
        // xfs_quota exits 0 on failure: the script reads both back.
        expect(s).toContain("grep -q 'projid = 1000007$'")
        expect(s).toContain('$4==20971520')
        expect(s).toContain('mknod "$src" b')
        expect(() => buildQuotaScript('/var/lib/docker', "/x'; rm -rf /", 1, 1)).toThrow()
        expect(() => buildQuotaScript('/var/lib/docker', '/x', 1, 0)).toThrow()
    })
})
