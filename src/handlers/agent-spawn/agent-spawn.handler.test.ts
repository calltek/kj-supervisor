import { describe, expect, test } from 'bun:test'

import { type KJContainerSummary } from '../../docker/client/client'
import { KJLogger } from '../../logger'
import type { AgentSpawnPayload, AgentStatusReport } from '../../protocol'
import { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'
import { AgentSpawnHandler } from './agent-spawn.handler'

const silentLogger = KJLogger.create('error')

class FakeDocker {
    public pulled: string[] = []
    public ran: Array<{ image_tag: string; name: string; labels: Record<string, string> }> = []
    public containers: KJContainerSummary[] = []
    public next_pull_error: Error | null = null
    public next_run_error: Error | null = null

    async pullImage(image_tag: string): Promise<void> {
        if (this.next_pull_error) throw this.next_pull_error
        this.pulled.push(image_tag)
    }

    async runContainer(opts: {
        image_tag: string
        name: string
        labels: Record<string, string>
    }): Promise<string> {
        if (this.next_run_error) throw this.next_run_error
        const id = `container-${this.ran.length + 1}`
        this.ran.push({ image_tag: opts.image_tag, name: opts.name, labels: opts.labels })
        return id
    }

    async listKjContainers(): Promise<KJContainerSummary[]> {
        return this.containers
    }
}

class FakeClient {
    public pushes: Array<{ event: string; payload: unknown }> = []
    push(event: string, payload: unknown): void {
        this.pushes.push({ event, payload })
    }
}

function makePayload(overrides: Partial<AgentSpawnPayload> = {}): AgentSpawnPayload {
    return {
        request_id: 'req-1',
        agent_id: 42,
        image_tag: 'alpine:latest',
        env: { KJ_AGENT_ID: '42' },
        skills: [],
        memories: [],
        resources: { memory_mb: 128, cpu: 0.25 },
        ...overrides,
    }
}

function statuses(client: FakeClient): AgentStatusReport[] {
    return client.pushes
        .filter((p) => p.event === 'agent:status')
        .map((p) => p.payload as AgentStatusReport)
}

/** Collapse consecutive same-status pushes — heartbeats produce duplicates. */
function statusTransitions(client: FakeClient): AgentStatusReport['status'][] {
    const out: AgentStatusReport['status'][] = []
    for (const s of statuses(client)) {
        if (out[out.length - 1] !== s.status) out.push(s.status)
    }
    return out
}

/** Wait until the background spawn promise has finished pushing its final status. */
async function waitForFinalStatus(client: FakeClient, expected: AgentStatusReport['status']) {
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
        const list = statuses(client)
        if (list.some((s) => s.status === expected)) return
        await new Promise((r) => setImmediate(r))
    }
    throw new Error(
        `timed out waiting for status=${expected}; got=${statuses(client)
            .map((s) => s.status)
            .join(',')}`
    )
}

describe('AgentSpawnHandler', () => {
    test('happy path: ack accepted, SPAWNING then RUNNING pushed', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        const ack = await handler.handle(makePayload())
        expect(ack).toEqual({ ok: true, accepted: true })

        await waitForFinalStatus(client, 'RUNNING')
        expect(statusTransitions(client)).toEqual(['SPAWNING', 'RUNNING'])

        expect(docker.pulled).toEqual(['alpine:latest'])
        expect(docker.ran).toHaveLength(1)
        expect(docker.ran[0]?.name).toBe('kj-agent-42')
        expect(docker.ran[0]?.labels).toEqual({
            'kj-agent': 'true',
            'kj-agent-id': '42',
        })
    })

    test('rejects when a container for the agent_id already exists', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'existing-abc', agent_id: 42 }]

        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        const ack = await handler.handle(makePayload())
        expect(ack.ok).toBe(false)
        if (ack.ok) throw new Error('unreachable')
        expect(ack.error.code as string).toBe('ALREADY_RUNNING')
        expect(ack.error.retryable).toBe(false)

        // No pull, no run, no SPAWNING push.
        expect(docker.pulled).toEqual([])
        expect(docker.ran).toHaveLength(0)
        expect(statuses(client)).toEqual([])
    })

    test('image pull failure pushes ERROR (ack still accepts)', async () => {
        const docker = new FakeDocker()
        docker.next_pull_error = new Error('manifest unknown')

        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        const ack = await handler.handle(makePayload())
        expect(ack).toEqual({ ok: true, accepted: true })

        await waitForFinalStatus(client, 'ERROR')
        expect(statusTransitions(client)).toEqual(['SPAWNING', 'ERROR'])
        const seen = statuses(client)
        expect(seen[seen.length - 1]?.last_action).toContain('manifest unknown')

        // Container never started.
        expect(docker.ran).toHaveLength(0)
    })

    test('docker run failure pushes ERROR after a successful pull', async () => {
        const docker = new FakeDocker()
        docker.next_run_error = new Error('no space left on device')

        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await handler.handle(makePayload())
        await waitForFinalStatus(client, 'ERROR')

        expect(docker.pulled).toEqual(['alpine:latest'])
        expect(statusTransitions(client)).toEqual(['SPAWNING', 'ERROR'])
        const seen = statuses(client)
        expect(seen[seen.length - 1]?.last_action).toContain('no space left on device')
    })
})
