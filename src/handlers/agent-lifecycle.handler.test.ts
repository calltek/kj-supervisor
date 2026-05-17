import { describe, expect, test } from 'bun:test'

import type { KJContainerSummary } from '../docker/client'
import { OperationTracker } from '../docker/operation-tracker'
import { KJLogger } from '../logger'
import type { AgentStatusReport } from '../protocol'
import { AgentStatusReporter } from '../reporters/agent-status.reporter'
import { AgentLifecycleHandler } from './agent-lifecycle.handler'

const silentLogger = KJLogger.create('error')

class FakeDocker {
    public containers: KJContainerSummary[] = []
    public stop_calls: Array<{ container_id: string; force?: boolean }> = []
    public remove_calls: string[] = []
    public pause_calls: string[] = []
    public unpause_calls: string[] = []
    public next_stop_error: Error | null = null
    public next_pause_error: Error | null = null
    public next_unpause_error: Error | null = null

    async listKjContainers(): Promise<KJContainerSummary[]> {
        return this.containers
    }
    async stopContainer(container_id: string, opts: { force?: boolean } = {}): Promise<void> {
        if (this.next_stop_error) throw this.next_stop_error
        this.stop_calls.push({ container_id, force: opts.force })
    }
    async removeContainer(container_id: string): Promise<void> {
        this.remove_calls.push(container_id)
    }
    async pauseContainer(container_id: string): Promise<void> {
        if (this.next_pause_error) throw this.next_pause_error
        this.pause_calls.push(container_id)
    }
    async unpauseContainer(container_id: string): Promise<void> {
        if (this.next_unpause_error) throw this.next_unpause_error
        this.unpause_calls.push(container_id)
    }
}

class FakeClient {
    public pushes: Array<{ event: string; payload: unknown }> = []
    push(event: string, payload: unknown): void {
        this.pushes.push({ event, payload })
    }
}

function makeHandler(docker: FakeDocker, client: FakeClient): AgentLifecycleHandler {
    return new AgentLifecycleHandler({
        docker: docker as never,
        tracker: new OperationTracker(),
        status: new AgentStatusReporter(client, silentLogger),
        logger: silentLogger,
    })
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

async function waitForFinalStatus(client: FakeClient, expected: AgentStatusReport['status']) {
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
        if (statuses(client).some((s) => s.status === expected)) return
        await new Promise((r) => setImmediate(r))
    }
    throw new Error(
        `timed out waiting for status=${expected}; got=${statuses(client)
            .map((s) => s.status)
            .join(',')}`
    )
}

describe('AgentLifecycleHandler.handleStop', () => {
    test('happy path: STOPPING → STOPPED, container removed', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'abc123', agent_id: 7 }]
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        const ack = await handler.handleStop({ request_id: 'r1', agent_id: 7 })
        expect(ack).toEqual({ ok: true, accepted: true })

        await waitForFinalStatus(client, 'STOPPED')
        expect(statusTransitions(client)).toEqual(['STOPPING', 'STOPPED'])
        expect(docker.stop_calls).toEqual([{ container_id: 'abc123', force: undefined }])
        expect(docker.remove_calls).toEqual(['abc123'])
    })

    test('force:true is passed through to stopContainer', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'abc', agent_id: 7 }]
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handleStop({ request_id: 'r1', agent_id: 7, force: true })
        await waitForFinalStatus(client, 'STOPPED')

        expect(docker.stop_calls[0]?.force).toBe(true)
    })

    test('rejects when no container exists for the agent_id', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        const ack = await handler.handleStop({ request_id: 'r1', agent_id: 99 })
        expect(ack.ok).toBe(false)
        if (ack.ok) throw new Error('unreachable')
        expect(ack.error.code as string).toBe('NO_CONTAINER')
        expect(docker.stop_calls).toHaveLength(0)
        expect(statuses(client)).toEqual([])
    })

    test('docker failure pushes ERROR with the underlying message', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'abc', agent_id: 7 }]
        docker.next_stop_error = new Error('docker daemon down')
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handleStop({ request_id: 'r1', agent_id: 7 })
        await waitForFinalStatus(client, 'ERROR')

        const seen = statuses(client)
        expect(seen.map((s) => s.status)).toEqual(['STOPPING', 'ERROR'])
        expect(seen[1]?.last_action).toContain('docker daemon down')
    })
})

describe('AgentLifecycleHandler.handlePause', () => {
    test('happy path: PAUSING → PAUSED', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'abc', agent_id: 7 }]
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        const ack = await handler.handlePause({ request_id: 'r1', agent_id: 7 })
        expect(ack).toEqual({ ok: true, accepted: true })

        await waitForFinalStatus(client, 'PAUSED')
        expect(statuses(client).map((s) => s.status)).toEqual(['PAUSING', 'PAUSED'])
        expect(docker.pause_calls).toEqual(['abc'])
    })

    test('rejects when no container exists', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const ack = await makeHandler(docker, client).handlePause({
            request_id: 'r1',
            agent_id: 99,
        })
        expect(ack.ok).toBe(false)
    })

    test('docker failure pushes ERROR', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'abc', agent_id: 7 }]
        docker.next_pause_error = new Error('already paused')
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handlePause({ request_id: 'r1', agent_id: 7 })
        await waitForFinalStatus(client, 'ERROR')

        const seen = statuses(client)
        expect(seen.map((s) => s.status)).toEqual(['PAUSING', 'ERROR'])
        expect(seen[1]?.last_action).toContain('already paused')
    })
})

describe('AgentLifecycleHandler.handleResume', () => {
    test('happy path: RESUMING → RUNNING', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'abc', agent_id: 7 }]
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        const ack = await handler.handleResume({ request_id: 'r1', agent_id: 7 })
        expect(ack).toEqual({ ok: true, accepted: true })

        await waitForFinalStatus(client, 'RUNNING')
        expect(statuses(client).map((s) => s.status)).toEqual(['RESUMING', 'RUNNING'])
        expect(docker.unpause_calls).toEqual(['abc'])
    })

    test('rejects when no container exists', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const ack = await makeHandler(docker, client).handleResume({
            request_id: 'r1',
            agent_id: 99,
        })
        expect(ack.ok).toBe(false)
    })

    test('docker failure pushes ERROR', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'abc', agent_id: 7 }]
        docker.next_unpause_error = new Error('not paused')
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handleResume({ request_id: 'r1', agent_id: 7 })
        await waitForFinalStatus(client, 'ERROR')

        const seen = statuses(client)
        expect(seen.map((s) => s.status)).toEqual(['RESUMING', 'ERROR'])
        expect(seen[1]?.last_action).toContain('not paused')
    })
})
