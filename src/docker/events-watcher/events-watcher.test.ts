import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import { KJLogger } from '../../logger'
import type { AgentStatusReport } from '../../protocol'
import { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'
import { KJDockerEventsWatcher } from './events-watcher'
import { OperationTracker } from '../operation-tracker/operation-tracker'

const silentLogger = KJLogger.create('error')

class FakeDocker {
    public stream = new PassThrough()
    public events_calls = 0

    async getEvents(): Promise<NodeJS.ReadableStream> {
        this.events_calls += 1
        return this.stream
    }
}

class FakeClient {
    public pushes: Array<{ event: string; payload: unknown }> = []
    push(event: string, payload: unknown): void {
        this.pushes.push({ event, payload })
    }
}

function statuses(client: FakeClient): AgentStatusReport[] {
    return client.pushes
        .filter((p) => p.event === 'agent:status')
        .map((p) => p.payload as AgentStatusReport)
}

function makeEvent(action: string, container_id: string, agent_id: number): string {
    return `${JSON.stringify({
        Type: 'container',
        Action: action,
        Actor: { ID: container_id, Attributes: { 'kj-agent-id': String(agent_id) } },
    })}\n`
}

async function flush(): Promise<void> {
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
}

describe('KJDockerEventsWatcher', () => {
    test('translates external die → STOPPED push', async () => {
        const docker = new FakeDocker()
        const tracker = new OperationTracker()
        const client = new FakeClient()
        const watcher = new KJDockerEventsWatcher({
            docker: docker as never,
            tracker,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await watcher.start()
        docker.stream.write(makeEvent('die', 'container-abc', 42))
        await flush()

        const list = statuses(client)
        expect(list).toHaveLength(1)
        expect(list[0]?.status).toBe('STOPPED')
        expect(list[0]?.agent_id).toBe(42)
        expect(list[0]?.container_id).toBe('container-abc')
        expect(list[0]?.last_action).toContain('external die')

        watcher.stop()
    })

    test('ignores events for containers we have tracked as ours', async () => {
        const docker = new FakeDocker()
        const tracker = new OperationTracker()
        tracker.track('container-abc')
        const client = new FakeClient()
        const watcher = new KJDockerEventsWatcher({
            docker: docker as never,
            tracker,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await watcher.start()
        docker.stream.write(makeEvent('die', 'container-abc', 42))
        await flush()

        expect(statuses(client)).toEqual([])
        watcher.stop()
    })

    test('translates external pause/unpause/destroy', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const watcher = new KJDockerEventsWatcher({
            docker: docker as never,
            tracker: new OperationTracker(),
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await watcher.start()
        docker.stream.write(makeEvent('pause', 'c1', 1))
        docker.stream.write(makeEvent('unpause', 'c2', 2))
        docker.stream.write(makeEvent('destroy', 'c3', 3))
        await flush()

        const list = statuses(client)
        expect(list.map((s) => ({ status: s.status, agent_id: s.agent_id }))).toEqual([
            { status: 'PAUSED', agent_id: 1 },
            { status: 'RUNNING', agent_id: 2 },
            { status: 'STOPPED', agent_id: 3 },
        ])
        // destroy nulls out container_id since the container is gone.
        expect(list[2]?.container_id).toBeNull()

        watcher.stop()
    })

    test('skips events without an agent_id label', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const watcher = new KJDockerEventsWatcher({
            docker: docker as never,
            tracker: new OperationTracker(),
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await watcher.start()
        // No Actor.Attributes — must not crash, must not push.
        docker.stream.write(
            `${JSON.stringify({ Type: 'container', Action: 'die', Actor: { ID: 'x' } })}\n`
        )
        await flush()

        expect(statuses(client)).toEqual([])
        watcher.stop()
    })

    test('handles malformed JSON lines without crashing', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const watcher = new KJDockerEventsWatcher({
            docker: docker as never,
            tracker: new OperationTracker(),
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await watcher.start()
        docker.stream.write('this is not json\n')
        docker.stream.write(makeEvent('die', 'c1', 1))
        await flush()

        // Valid event still gets through.
        expect(statuses(client).map((s) => s.status)).toEqual(['STOPPED'])
        watcher.stop()
    })

    test('skips create/start/attach actions we do not surface', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const watcher = new KJDockerEventsWatcher({
            docker: docker as never,
            tracker: new OperationTracker(),
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await watcher.start()
        for (const action of ['create', 'start', 'attach', 'exec_start']) {
            docker.stream.write(makeEvent(action, 'c1', 1))
        }
        await flush()

        expect(statuses(client)).toEqual([])
        watcher.stop()
    })
})
