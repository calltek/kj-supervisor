import { describe, expect, it } from 'bun:test'
import { KJLogger } from '../../logger'
import { startAgentDiskLoop } from './agent-disk.reporter'

const GB = 1024 ** 3

function setup(used_bytes: number) {
    const pushed: Array<[string, unknown]> = []
    const statuses: unknown[] = []
    const stopped: string[] = []
    const handle = startAgentDiskLoop({
        docker: {
            listDiskLimitedAgents: async () => [
                {
                    agent_id: 7,
                    container_id: 'c7',
                    disk_gb: 10,
                    volumes: ['kj-agent-7-home'],
                    writable_bytes: 0,
                },
            ],
            measureVolumes: async () => new Map([[7, used_bytes]]),
            stopContainer: async (id: string) => {
                stopped.push(id)
            },
            removeContainer: async () => undefined,
        },
        client: { push: (e, p) => pushed.push([e, p]) },
        status: { push: (r) => statuses.push(r) },
        tracker: { track: () => undefined, untrack: () => undefined },
        logger: KJLogger.create('error'),
        interval_ms: 1_000_000,
    })
    return { handle, pushed, statuses, stopped }
}

describe('agent disk watch', () => {
    it('reports a warning at 80 % and leaves the agent running', async () => {
        const t = setup(8 * GB)
        await t.handle.tick()
        t.handle.stop()
        expect(t.pushed).toEqual([
            ['agent:disk', { agent_id: 7, used_mb: 8192, limit_mb: 10240, level: 'warn' }],
        ])
        expect(t.stopped).toEqual([])
    })

    it('stops the agent at its ceiling, as ERROR with disk_limit_reached', async () => {
        const t = setup(10 * GB)
        await t.handle.tick()
        t.handle.stop()
        expect(t.stopped).toEqual(['c7'])
        expect(t.statuses).toMatchObject([
            { agent_id: 7, status: 'ERROR', last_action_code: 'disk_limit_reached' },
        ])
    })
})
