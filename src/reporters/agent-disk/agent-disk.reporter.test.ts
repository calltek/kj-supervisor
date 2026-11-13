import { describe, expect, it } from 'bun:test'
import { KJLogger } from '../../logger'
import { MAX_FAILED_MEASURES, startAgentDiskLoop } from './agent-disk.reporter'

const GB = 1024 ** 3

/** Agent 7 and 8, 10 GB each; `used` per agent: bytes, or 'fail' for a measure that throws. */
function setup(used: Record<number, number | 'fail'>, shared = false) {
    const pushed: Array<[string, unknown]> = []
    const statuses: Array<{ agent_id: number; last_action_code?: string }> = []
    const stopped: string[] = []
    const handle = startAgentDiskLoop({
        docker: {
            listDiskLimitedAgents: async () =>
                Object.keys(used).map((id) => ({
                    agent_id: Number(id),
                    container_id: `c${id}`,
                    disk_gb: 10,
                    volumes: [`kj-agent-${id}-home`],
                    writable_bytes: 0,
                })),
            measureVolumes: async (groups: Map<number, string[]>) => {
                const id = [...groups.keys()][0] as number
                const v = used[id]
                if (v === 'fail') throw new Error('disk measure timed out')
                return new Map<number, number>([[id, v as number]])
            },
            stopContainer: async (id: string) => {
                stopped.push(id)
            },
            removeContainer: async () => undefined,
            isShared: () => shared,
        },
        client: { push: (e, p) => pushed.push([e, p]) },
        status: { push: (r) => statuses.push(r as (typeof statuses)[number]) },
        tracker: { track: () => undefined, untrack: () => undefined },
        logger: KJLogger.create('error'),
        interval_ms: 1_000_000,
    })
    return { handle, pushed, statuses, stopped }
}

describe('agent disk watch', () => {
    it('reports a warning at 80 % and leaves the agent running', async () => {
        const t = setup({ 7: 8 * GB })
        await t.handle.tick()
        t.handle.stop()
        expect(t.pushed).toEqual([
            ['agent:disk', { agent_id: 7, used_mb: 8192, limit_mb: 10240, level: 'warn' }],
        ])
        expect(t.stopped).toEqual([])
    })

    it('stops the agent at its ceiling, as ERROR with disk_limit_reached', async () => {
        const t = setup({ 7: 10 * GB })
        await t.handle.tick()
        t.handle.stop()
        expect(t.stopped).toEqual(['c7'])
        expect(t.statuses).toMatchObject([
            { agent_id: 7, status: 'ERROR', last_action_code: 'disk_limit_reached' },
        ])
    })

    it("one agent whose measure fails doesn't keep a full one from being stopped", async () => {
        const t = setup({ 7: 'fail', 8: 10 * GB })
        await t.handle.tick()
        t.handle.stop()
        expect(t.stopped).toEqual(['c8'])
        // A failed measure is not reported as an empty disk.
        expect(t.pushed.map(([, p]) => (p as { agent_id: number }).agent_id)).toEqual([8])
    })

    it('on a shared machine, an agent that cannot be measured is stopped after a few tries', async () => {
        const t = setup({ 7: 'fail' }, true)
        for (let i = 1; i < MAX_FAILED_MEASURES; i++) await t.handle.tick()
        expect(t.stopped).toEqual([])
        await t.handle.tick()
        t.handle.stop()
        expect(t.stopped).toEqual(['c7'])
        expect(t.statuses).toMatchObject([{ agent_id: 7, last_action_code: 'disk_limit_reached' }])
    })

    it('on a dedicated machine, a failed measure never stops the agent', async () => {
        const t = setup({ 7: 'fail' })
        for (let i = 0; i < MAX_FAILED_MEASURES + 1; i++) await t.handle.tick()
        t.handle.stop()
        expect(t.stopped).toEqual([])
    })
})
