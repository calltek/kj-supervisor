import { describe, expect, test } from 'bun:test'

import { KJLogger } from '../../logger'
import { AgentStatusReporter } from '../agent-status/agent-status.reporter'
import { AgentImageReporter, type ImageInspector } from './agent-image.reporter'

const silentLogger = KJLogger.create('error')

class FakeClient {
    public pushed: Array<{ event: string; payload: unknown }> = []
    push(event: string, payload: unknown): void {
        this.pushed.push({ event, payload })
    }
}

class FakeDocker implements ImageInspector {
    public inspects = 0
    public fail = false
    /** container_id → image id */
    public containers = new Map<string, string>([
        ['c-new', 'sha256:new'],
        ['c-local', 'sha256:local'],
    ])
    public images = new Map<string, { Created?: string; Labels?: Record<string, string> }>([
        [
            'sha256:new',
            {
                Created: '2026-10-03T09:15:02.123Z',
                Labels: {
                    'org.opencontainers.image.revision': 'd889f78aaaabbbbccccddddeeeeffff000011112',
                    'org.opencontainers.image.created': '2026-10-03T09:14:00.000Z',
                },
            },
        ],
        ['sha256:local', { Created: '2026-10-01T10:00:00.000Z' }],
    ])

    async inspect(container_id: string) {
        this.inspects++
        if (this.fail) throw new Error('daemon down')
        return { Image: this.containers.get(container_id) }
    }

    async inspectImage(image: string) {
        const found = this.images.get(image)
        if (!found) throw new Error('no such image')
        return { Created: found.Created, Config: { Labels: found.Labels ?? null } }
    }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('AgentImageReporter', () => {
    test('reports the commit and build date from the IMAGE labels', async () => {
        const client = new FakeClient()
        new AgentImageReporter(client, new FakeDocker(), silentLogger).report(7, 'c-new')
        await settle()
        expect(client.pushed).toEqual([
            {
                event: 'agent:image:report',
                payload: {
                    agent_id: 7,
                    container_id: 'c-new',
                    revision: 'd889f78aaaabbbbccccddddeeeeffff000011112',
                    built_at: '2026-10-03T09:14:00.000Z',
                },
            },
        ])
    })

    test('an image without labels (a local build) reports no commit and its own date', async () => {
        const client = new FakeClient()
        new AgentImageReporter(client, new FakeDocker(), silentLogger).report(7, 'c-local')
        await settle()
        expect(client.pushed[0]?.payload).toMatchObject({
            revision: null,
            built_at: '2026-10-01T10:00:00.000Z',
        })
    })

    test('the same container is reported once; a new one is reported again', async () => {
        const client = new FakeClient()
        const docker = new FakeDocker()
        const reporter = new AgentImageReporter(client, docker, silentLogger)
        reporter.report(7, 'c-new')
        reporter.report(7, 'c-new')
        await settle()
        reporter.report(7, 'c-local')
        await settle()
        expect(docker.inspects).toBe(2)
        expect(
            client.pushed.map((p) => (p.payload as { container_id: string }).container_id)
        ).toEqual(['c-new', 'c-local'])
    })

    test('a failed read pushes nothing and lets the next RUNNING retry', async () => {
        const client = new FakeClient()
        const docker = new FakeDocker()
        const reporter = new AgentImageReporter(client, docker, silentLogger)
        docker.fail = true
        reporter.report(7, 'c-new')
        await settle()
        expect(client.pushed).toEqual([])
        docker.fail = false
        reporter.report(7, 'c-new')
        await settle()
        expect(client.pushed).toHaveLength(1)
    })
})

describe('AgentStatusReporter → image report', () => {
    test('only a RUNNING push with a container triggers it, and always after the status', async () => {
        const client = new FakeClient()
        const status = new AgentStatusReporter(
            client,
            silentLogger,
            new AgentImageReporter(client, new FakeDocker(), silentLogger)
        )
        status.push({ agent_id: 7, status: 'SPAWNING', container_id: 'c-new' })
        status.push({ agent_id: 7, status: 'RUNNING', container_id: null })
        status.push({ agent_id: 7, status: 'RUNNING', container_id: 'c-new' })
        await settle()
        expect(client.pushed.map((p) => p.event)).toEqual([
            'agent:status',
            'agent:status',
            'agent:status',
            'agent:image:report',
        ])
    })
})
