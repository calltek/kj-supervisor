import { describe, expect, test } from 'bun:test'

import type { KJContainerSummary } from '../../docker/client/client'
import { KJLogger } from '../../logger'
import type { AgentMetricsReport } from '../../protocol'
import { startAgentMetricsLoop } from './agent-metrics.reporter'

const silentLogger = KJLogger.create('error')

class FakeDocker {
    public containers: KJContainerSummary[] = []
    public inspects: Record<string, { Running: boolean; StartedAt: string }> = {}
    public list_error: Error | null = null

    async listKjContainers(): Promise<KJContainerSummary[]> {
        if (this.list_error) throw this.list_error
        return this.containers
    }

    async inspect(container_id: string) {
        const state = this.inspects[container_id]
        if (!state) throw new Error(`no fake state for ${container_id}`)
        return { State: state } as never
    }
}

class FakeClient {
    public pushes: Array<{ event: string; payload: unknown }> = []
    push(event: string, payload: unknown): void {
        this.pushes.push({ event, payload })
    }
}

function metrics(client: FakeClient): AgentMetricsReport[] {
    return client.pushes
        .filter((p) => p.event === 'agent:metrics')
        .map((p) => p.payload as AgentMetricsReport)
}

describe('startAgentMetricsLoop', () => {
    test('pushes one agent:metrics per running container', async () => {
        const docker = new FakeDocker()
        docker.containers = [
            { container_id: 'c1', agent_id: 1 },
            { container_id: 'c2', agent_id: 2 },
        ]
        docker.inspects = {
            c1: { Running: true, StartedAt: new Date(Date.now() - 60_000).toISOString() },
            c2: { Running: true, StartedAt: new Date(Date.now() - 5_000).toISOString() },
        }
        const client = new FakeClient()
        const handle = startAgentMetricsLoop({
            docker: docker as never,
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })

        await handle.tick()
        handle.stop()

        const list = metrics(client)
        expect(list).toHaveLength(2)
        expect(list.map((m) => m.agent_id).sort()).toEqual([1, 2])
        expect(list.every((m) => m.tokens_used === '0')).toBe(true)
        expect(list.every((m) => m.cost_micro === '0')).toBe(true)
        // uptime should be roughly correct (60s and 5s).
        const byId = new Map(list.map((m) => [m.agent_id, m]))
        expect(byId.get(1)?.uptime_seconds).toBeGreaterThanOrEqual(55)
        expect(byId.get(2)?.uptime_seconds).toBeLessThanOrEqual(10)
    })

    test('skips containers that are not Running', async () => {
        const docker = new FakeDocker()
        docker.containers = [
            { container_id: 'c1', agent_id: 1 },
            { container_id: 'c2', agent_id: 2 },
        ]
        docker.inspects = {
            c1: { Running: true, StartedAt: new Date().toISOString() },
            c2: { Running: false, StartedAt: new Date().toISOString() },
        }
        const client = new FakeClient()
        const handle = startAgentMetricsLoop({
            docker: docker as never,
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })

        await handle.tick()
        handle.stop()

        const list = metrics(client)
        expect(list).toHaveLength(1)
        expect(list[0]?.agent_id).toBe(1)
    })

    test('skips containers without an agent_id label', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c1', agent_id: null }]
        const client = new FakeClient()
        const handle = startAgentMetricsLoop({
            docker: docker as never,
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })

        await handle.tick()
        handle.stop()

        expect(metrics(client)).toEqual([])
    })

    test('continues when one container fails to inspect', async () => {
        const docker = new FakeDocker()
        docker.containers = [
            { container_id: 'c1', agent_id: 1 },
            { container_id: 'c2', agent_id: 2 },
        ]
        docker.inspects = {
            c2: { Running: true, StartedAt: new Date().toISOString() },
            // c1 missing → inspect throws
        }
        const client = new FakeClient()
        const handle = startAgentMetricsLoop({
            docker: docker as never,
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })

        await handle.tick()
        handle.stop()

        const list = metrics(client)
        expect(list).toHaveLength(1)
        expect(list[0]?.agent_id).toBe(2)
    })

    test('list error aborts the whole tick (next tick may recover)', async () => {
        const docker = new FakeDocker()
        docker.list_error = new Error('docker daemon down')
        const client = new FakeClient()
        const handle = startAgentMetricsLoop({
            docker: docker as never,
            client,
            logger: silentLogger,
            interval_ms: 60_000,
        })

        await handle.tick()
        handle.stop()

        expect(metrics(client)).toEqual([])
    })
})
