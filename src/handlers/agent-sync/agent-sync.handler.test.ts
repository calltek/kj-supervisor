import { describe, expect, test } from 'bun:test'

import { AgentStreamManager } from '../../agent-stream/stream-manager'
import { KJLogger } from '../../logger'
import type { AgentSyncPayload } from '../../protocol'
import { AgentSyncHandler } from './agent-sync.handler'

const silentLogger = KJLogger.create('error')

class FakeDocker {
    public attached: string[] = []
    public next_attach_error: Map<string, Error> = new Map()

    async attachContainer(container_id: string): Promise<NodeJS.ReadWriteStream> {
        const err = this.next_attach_error.get(container_id)
        if (err) throw err
        this.attached.push(container_id)
        const { PassThrough } = await import('node:stream')
        return new PassThrough() as unknown as NodeJS.ReadWriteStream
    }

    demuxAttachStream(): void {
        // no-op for tests
    }
}

class FakeClient {
    public pushed: Array<{ event: string; payload: unknown }> = []
    push(event: string, payload: unknown): void {
        this.pushed.push({ event, payload })
    }
}

function makeHandler(docker: FakeDocker = new FakeDocker()) {
    const client = new FakeClient()
    const streams = new AgentStreamManager({
        docker: docker as unknown as ConstructorParameters<typeof AgentStreamManager>[0]['docker'],
        client,
        logger: silentLogger,
    })
    return {
        handler: new AgentSyncHandler({ streams, logger: silentLogger }),
        docker,
        streams,
    }
}

describe('AgentSyncHandler', () => {
    test('attaches every entry and acks ok', async () => {
        const { handler, docker } = makeHandler()

        const payload: AgentSyncPayload = {
            request_id: 'req-1',
            entries: [
                {
                    agent_id: 1,
                    container_id: 'c-1',
                    session_id: 'sess-1',
                    oauth_token: 'tok-1',
                    conversations: [],
                },
                {
                    agent_id: 2,
                    container_id: 'c-2',
                    session_id: 'sess-2',
                    oauth_token: 'tok-2',
                    conversations: [],
                },
            ],
        }

        const ack = await handler.handle(payload)

        expect(ack).toEqual({ ok: true, accepted: true })
        expect(docker.attached.sort()).toEqual(['c-1', 'c-2'])
    })

    test('empty entries acks ok with no attach calls', async () => {
        const { handler, docker } = makeHandler()
        const ack = await handler.handle({ request_id: 'req-empty', entries: [] })
        expect(ack).toEqual({ ok: true, accepted: true })
        expect(docker.attached).toHaveLength(0)
    })

    test('individual attach failures are swallowed; ack still ok', async () => {
        const docker = new FakeDocker()
        docker.next_attach_error.set('c-broken', new Error('container vanished'))
        const { handler } = makeHandler(docker)

        const payload: AgentSyncPayload = {
            request_id: 'req-partial',
            entries: [
                {
                    agent_id: 1,
                    container_id: 'c-broken',
                    session_id: 'sess-1',
                    oauth_token: 'tok-1',
                    conversations: [],
                },
                {
                    agent_id: 2,
                    container_id: 'c-ok',
                    session_id: 'sess-2',
                    oauth_token: 'tok-2',
                    conversations: [],
                },
            ],
        }

        const ack = await handler.handle(payload)
        // The handler treats partial failures as best-effort — it
        // logs them and still acks ok so the next reconcile doesn't
        // block waiting for an answer the supervisor isn't going
        // to send.
        expect(ack).toEqual({ ok: true, accepted: true })
        // Only the healthy attach made it through.
        expect(docker.attached).toEqual(['c-ok'])
    })

    test('attach to an already-streaming agent is a no-op (idempotent)', async () => {
        const { handler, streams, docker } = makeHandler()

        // Pre-attach via the manager directly to simulate "already streaming".
        await streams.attach({
            agent_id: 1,
            container_id: 'c-1',
            session_id: 'sess-1',
        })
        expect(docker.attached).toEqual(['c-1'])

        // Now ask the handler to attach the same agent again.
        const ack = await handler.handle({
            request_id: 'req-dup',
            entries: [
                {
                    agent_id: 1,
                    container_id: 'c-1',
                    session_id: 'sess-1',
                    oauth_token: 'tok-1',
                    conversations: [],
                },
            ],
        })

        expect(ack).toEqual({ ok: true, accepted: true })
        // No second attach call — the manager short-circuited.
        expect(docker.attached).toEqual(['c-1'])
    })
})
