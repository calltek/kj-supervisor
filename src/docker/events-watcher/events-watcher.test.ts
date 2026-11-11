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

class FakeStreams {
    public detached: number[] = []
    public attached: Array<{ agent_id: number; container_id: string; session_id: string }> = []
    private live = new Set<number>()
    detach(agent_id: number): void {
        this.detached.push(agent_id)
        this.live.delete(agent_id)
    }
    isAttached(agent_id: number): boolean {
        return this.live.has(agent_id)
    }
    async attach(opts: { agent_id: number; container_id: string; session_id: string }) {
        this.attached.push(opts)
        this.live.add(opts.agent_id)
    }
}

class RestartingDocker extends FakeDocker {
    constructor(private readonly restart_count: number) {
        super()
    }
    async inspect() {
        return {
            State: { Running: true },
            RestartCount: this.restart_count,
            Config: { Env: ['KJ_AGENT_ID=48', 'KJ_SESSION_ID=sess-48'] },
        }
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
    test('an agent Docker restarted on its own is re-attached and reported RUNNING', async () => {
        // GAZ, 2026-11-11: OOM inside its 2 GB, `unless-stopped` brought it
        // back, and nobody attached to the new run — RUNNING and deaf.
        const docker = new RestartingDocker(1)
        const streams = new FakeStreams()
        const client = new FakeClient()
        const watcher = new KJDockerEventsWatcher({
            streams: streams as never,
            docker: docker as never,
            tracker: new OperationTracker(),
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await watcher.start()
        docker.stream.write(makeEvent('die', 'c-48', 48))
        docker.stream.write(makeEvent('start', 'c-48', 48))
        await flush()

        expect(streams.attached).toEqual([
            { agent_id: 48, container_id: 'c-48', session_id: 'sess-48' },
        ])
        expect(statuses(client).map((s) => s.status)).toEqual(['STOPPED', 'RUNNING'])
        watcher.stop()
    })

    test('a first start is left to the spawn handler', async () => {
        const docker = new RestartingDocker(0)
        const streams = new FakeStreams()
        const watcher = new KJDockerEventsWatcher({
            streams: streams as never,
            docker: docker as never,
            tracker: new OperationTracker(),
            status: new AgentStatusReporter(new FakeClient(), silentLogger),
            logger: silentLogger,
        })

        await watcher.start()
        docker.stream.write(makeEvent('start', 'c-48', 48))
        await flush()

        expect(streams.attached).toEqual([])
        watcher.stop()
    })

    test('a restarted container gets its network rules back; if they fail, ERROR', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const enforced: Array<[number, string]> = []
        const watcher = new KJDockerEventsWatcher({
            streams: new FakeStreams() as never,
            docker: docker as never,
            tracker: new OperationTracker(),
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
            netPolicy: {
                enforce: async (agent_id, container_id) => {
                    enforced.push([agent_id, container_id])
                    return agent_id === 8
                        ? { ok: false, error: 'iptables', stopped: true }
                        : { ok: true }
                },
            },
        })

        await watcher.start()
        docker.stream.write(makeEvent('start', 'c-7', 7))
        docker.stream.write(makeEvent('start', 'c-8', 8))
        await flush()

        expect(enforced).toEqual([
            [7, 'c-7'],
            [8, 'c-8'],
        ])
        const list = statuses(client)
        expect(list).toHaveLength(1)
        expect(list[0]?.agent_id).toBe(8)
        expect(list[0]?.status).toBe('ERROR')
        expect(list[0]?.last_action_code).toBe('network_policy_failed')
        watcher.stop()
    })

    test('translates external die → STOPPED push', async () => {
        const docker = new FakeDocker()
        const tracker = new OperationTracker()
        const client = new FakeClient()
        const watcher = new KJDockerEventsWatcher({
            streams: new FakeStreams() as never,
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
            streams: new FakeStreams() as never,
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
            streams: new FakeStreams() as never,
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
            streams: new FakeStreams() as never,
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
            streams: new FakeStreams() as never,
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
            streams: new FakeStreams() as never,
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
