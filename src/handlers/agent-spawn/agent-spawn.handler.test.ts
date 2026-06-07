import { describe, expect, test } from 'bun:test'

import { AgentStreamManager } from '../../agent-stream/stream-manager'
import { type KJContainerSummary } from '../../docker/client/client'
import { KJLogger } from '../../logger'
import type { AgentSpawnPayload, AgentStatusReport } from '../../protocol'
import { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'
import { AgentSpawnHandler } from './agent-spawn.handler'

const silentLogger = KJLogger.create('error')

interface PullCall {
    image_tag: string
    auth?: { username: string; password: string; serveraddress?: string }
}

class FakeDocker {
    public pulled: PullCall[] = []
    public ran: Array<{
        image_tag: string
        name: string
        labels: Record<string, string>
        env: Record<string, string>
    }> = []
    public attached: string[] = []
    public containers: KJContainerSummary[] = []
    public next_pull_error: Error | null = null
    public next_run_error: Error | null = null
    public image_exists_locally = false
    public exists_calls: string[] = []

    async imageExistsLocally(image_tag: string): Promise<boolean> {
        this.exists_calls.push(image_tag)
        return this.image_exists_locally
    }

    async pullImage(
        image_tag: string,
        _onProgress?: unknown,
        auth?: { username: string; password: string; serveraddress?: string }
    ): Promise<void> {
        if (this.next_pull_error) throw this.next_pull_error
        this.pulled.push({ image_tag, auth })
    }

    async runContainer(opts: {
        image_tag: string
        name: string
        labels: Record<string, string>
        env: Record<string, string>
    }): Promise<string> {
        if (this.next_run_error) throw this.next_run_error
        const id = `container-${this.ran.length + 1}`
        this.ran.push({
            image_tag: opts.image_tag,
            name: opts.name,
            labels: opts.labels,
            env: opts.env,
        })
        return id
    }

    async attachContainer(container_id: string): Promise<NodeJS.ReadWriteStream> {
        this.attached.push(container_id)
        const { PassThrough } = await import('node:stream')
        return new PassThrough() as unknown as NodeJS.ReadWriteStream
    }

    demuxAttachStream(
        _stream: NodeJS.ReadableStream,
        _stdout: NodeJS.WritableStream,
        _stderr: NodeJS.WritableStream
    ): void {
        // no-op for tests
    }

    async listKjContainers(): Promise<KJContainerSummary[]> {
        return this.containers
    }

    /**
     * The real KJDocker.seedVolumeFiles writes operator memories +
     * CLAUDE.md into the agent's home volume before the container
     * boots. The handler invokes it for any non-alpine image (alpine
     * is the smoke-test escape hatch). The mock just records the call
     * so we don't have to think about the volume seed in spawn tests.
     */
    public seeded: Array<{ volume_name: string; target_dir: string; files: unknown[] }> = []
    async seedVolumeFiles(opts: {
        volume_name: string
        target_dir: string
        purge?: boolean
        files: unknown[]
    }): Promise<void> {
        this.seeded.push({
            volume_name: opts.volume_name,
            target_dir: opts.target_dir,
            files: opts.files,
        })
    }

    // Records the spawn's pre-seed `chown 1000:1000 /v` on the home volume.
    public ownedVolumes: string[] = []
    async ensureVolumeOwnership(volume_name: string): Promise<void> {
        this.ownedVolumes.push(volume_name)
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
        session_id: '00000000-0000-0000-0000-000000000042',
        oauth_token: 'test-oauth-token',
        env: { KJ_AGENT_ID: '42' },
        skills: [],
        memories: [],
        mcp_servers: [],
        conversations: [],
        resources: { memory_mb: 128, cpu: 0.25 },
        ...overrides,
    }
}

function makeStreams(docker: FakeDocker, client: FakeClient): AgentStreamManager {
    return new AgentStreamManager({
        docker: docker as never,
        client,
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
            streams: makeStreams(docker, client),
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        const ack = await handler.handle(makePayload())
        expect(ack).toEqual({ ok: true, accepted: true })

        await waitForFinalStatus(client, 'RUNNING')
        expect(statusTransitions(client)).toEqual(['SPAWNING', 'RUNNING'])

        expect(docker.pulled.map((p) => p.image_tag)).toEqual(['alpine:latest'])
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
            streams: makeStreams(docker, client),
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
    })

    test('propagates registry_credentials to pullImage when provided', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            streams: makeStreams(docker, client),
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        const payload = makePayload({
            image_tag: 'ghcr.io/calltek/kj-agent-base:latest',
            registry_credentials: {
                registry: 'ghcr.io',
                username: 'x-access-token',
                password: 'ghp_test_token',
            },
        })

        await handler.handle(payload)
        await waitForFinalStatus(client, 'RUNNING')

        expect(docker.pulled).toHaveLength(1)
        const call = docker.pulled[0]
        expect(call?.image_tag).toBe('ghcr.io/calltek/kj-agent-base:latest')
        expect(call?.auth).toEqual({
            username: 'x-access-token',
            password: 'ghp_test_token',
            serveraddress: 'ghcr.io',
        })
    })

    test('omits auth when registry_credentials is absent', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            streams: makeStreams(docker, client),
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await handler.handle(makePayload())
        await waitForFinalStatus(client, 'RUNNING')

        expect(docker.pulled).toHaveLength(1)
        expect(docker.pulled[0]?.auth).toBeUndefined()
    })

    test('seeds skills into .claude/skills before starting the container', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            streams: makeStreams(docker, client),
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await handler.handle(
            makePayload({
                // non-alpine image → real volume gets seeded.
                image_tag: 'ghcr.io/calltek/kj-agent-base:latest',
                skills: [
                    { path: 'code-review/SKILL.md', content: '---\nname: code-review\n---\nbody' },
                ],
            })
        )
        await waitForFinalStatus(client, 'RUNNING')

        const skillSeed = docker.seeded.find((s) => s.target_dir === '.claude/skills')
        expect(skillSeed).toBeDefined()
        expect(skillSeed?.files).toHaveLength(1)
        expect((skillSeed?.files[0] as { path: string }).path).toBe('code-review/SKILL.md')
    })

    test('still purges .claude/skills when the payload has zero skills', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            streams: makeStreams(docker, client),
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        // non-alpine image → real volume; skills: [] by default.
        await handler.handle(makePayload({ image_tag: 'ghcr.io/calltek/kj-agent-base:latest' }))
        await waitForFinalStatus(client, 'RUNNING')

        const skillSeed = docker.seeded.find((s) => s.target_dir === '.claude/skills')
        expect(skillSeed).toBeDefined()
        expect(skillSeed?.files).toHaveLength(0)
    })

    test('materialises mcp_servers into .kj/mcp-servers.json', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            streams: makeStreams(docker, client),
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await handler.handle(
            makePayload({
                image_tag: 'ghcr.io/calltek/kj-agent-base:latest',
                mcp_servers: [
                    {
                        name: 'github',
                        transport: 'STDIO',
                        command: 'npx',
                        args: ['-y', '@modelcontextprotocol/server-github'],
                        env: { GITHUB_TOKEN: 'ghp_decrypted' },
                    },
                ],
            })
        )
        await waitForFinalStatus(client, 'RUNNING')

        const mcpSeed = docker.seeded.find((s) => s.target_dir === '.kj')
        expect(mcpSeed).toBeDefined()
        const file = mcpSeed?.files[0] as { path: string; content: string }
        expect(file.path).toBe('mcp-servers.json')
        const parsed = JSON.parse(file.content) as Array<{ name: string }>
        expect(parsed).toHaveLength(1)
        expect(parsed[0]?.name).toBe('github')
    })

    test('writes an empty .kj/mcp-servers.json when no servers are assigned', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            streams: makeStreams(docker, client),
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        // non-alpine image → real volume; mcp_servers omitted by default.
        await handler.handle(makePayload({ image_tag: 'ghcr.io/calltek/kj-agent-base:latest' }))
        await waitForFinalStatus(client, 'RUNNING')

        const mcpSeed = docker.seeded.find((s) => s.target_dir === '.kj')
        expect(mcpSeed).toBeDefined()
        const file = mcpSeed?.files[0] as { content: string }
        expect(JSON.parse(file.content)).toEqual([])
    })

    test('image pull failure pushes ERROR (ack still accepts)', async () => {
        const docker = new FakeDocker()
        docker.next_pull_error = new Error('manifest unknown')

        const client = new FakeClient()
        const handler = new AgentSpawnHandler({
            streams: makeStreams(docker, client),
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
            streams: makeStreams(docker, client),
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            logger: silentLogger,
        })

        await handler.handle(makePayload())
        await waitForFinalStatus(client, 'ERROR')

        expect(docker.pulled.map((p) => p.image_tag)).toEqual(['alpine:latest'])
        expect(statusTransitions(client)).toEqual(['SPAWNING', 'ERROR'])
        const seen = statuses(client)
        expect(seen[seen.length - 1]?.last_action).toContain('no space left on device')
    })
})
