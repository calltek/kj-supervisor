/**
 * Tests for AgentImageUpdateHandler.
 *
 * Coverage anchors:
 *  - No existing container → pull + status STOPPED. The cache is
 *    primed for the next agent:spawn.
 *  - Existing container + restart_after=false → pull + stop + remove,
 *    status STOPPED. The operator restarts manually.
 *  - Existing container + restart_after=true → pull + recreate
 *    (same name, env preserved) + reattach stdio, status RUNNING.
 *  - Pull fails AND image cached locally → fallback continues with
 *    the cached copy (dev workflow + transitional missing creds).
 *  - Pull fails AND no cache → status ERROR / STOPPED, no swap.
 *  - The drain's limit comes from the control: absent → the old
 *    behaviour, `null` → no limit, a number → that (bottom block).
 */

import type {
    AgentImageUpdatePayload,
    AgentStatusReport,
    ControlCommandAck,
    WsErrorPayload,
} from '../../protocol'
import type { KJContainerSummary } from '../../docker/client/client'
import { OperationTracker } from '../../docker/operation-tracker/operation-tracker'
import { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'
import { AgentStreamManager } from '../../agent-stream/stream-manager'
import { McpDispatcher } from '../../agent-stream/mcp-dispatcher'
import { KJLogger } from '../../logger'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AgentImageUpdateHandler } from './agent-image-update.handler'

const silentLogger = KJLogger.create('error')

// ──────────────────────────────────────────────────────────────────────────
// Fakes
// ──────────────────────────────────────────────────────────────────────────

interface InspectInfo {
    Config?: { Env?: string[] | null }
    State?: { Running?: boolean; Restarting?: boolean; StartedAt?: string }
    RestartCount?: number
}

class FakeDocker {
    public pulled: Array<{
        image_tag: string
        auth?: { username: string; password: string; serveraddress?: string }
    }> = []
    public next_pull_error: Error | null = null
    public image_exists_locally = false
    public exists_calls: string[] = []
    public containers: KJContainerSummary[] = []
    public stopped: Array<{ container_id: string; force?: boolean }> = []
    public removed: string[] = []
    public recreated: Array<{
        source_container: string
        new_image_tag: string
        keep_name: string
    }> = []
    public recreate_returns: string = 'new-container-1'
    public next_recreate_error: Error | null = null
    public next_inspect: InspectInfo | null = null
    /** When set, wins over `next_inspect` — lets a test move the container along. */
    public inspect_fn: ((container_id: string) => InspectInfo) | null = null

    async pullImage(
        image_tag: string,
        _onProgress?: unknown,
        auth?: { username: string; password: string; serveraddress?: string }
    ): Promise<void> {
        if (this.next_pull_error) throw this.next_pull_error
        this.pulled.push({ image_tag, auth })
    }

    async imageExistsLocally(image_tag: string): Promise<boolean> {
        this.exists_calls.push(image_tag)
        return this.image_exists_locally
    }

    async listKjContainers(): Promise<KJContainerSummary[]> {
        return this.containers
    }

    async stopContainer(container_id: string, opts: { force?: boolean } = {}): Promise<void> {
        this.stopped.push({ container_id, force: opts.force })
    }

    async removeContainer(container_id: string): Promise<void> {
        this.removed.push(container_id)
    }

    async recreateContainerWithImage(opts: {
        source_container: string
        new_image_tag: string
        keep_name: string
    }): Promise<string> {
        if (this.next_recreate_error) throw this.next_recreate_error
        this.recreated.push(opts)
        return this.recreate_returns
    }

    async inspect(container_id: string): Promise<InspectInfo> {
        if (this.inspect_fn) return this.inspect_fn(container_id)
        return this.next_inspect ?? {}
    }
}

class FakeClient {
    public pushes: Array<{ event: string; payload: unknown }> = []
    push(event: string, payload: unknown): void {
        this.pushes.push({ event, payload })
    }
}

/**
 * AgentStreamManager needs a docker client + an MCP dispatcher. The
 * dispatcher is the real one but its callbacks are no-ops; the
 * manager only calls `detach` in our paths, which doesn't need any
 * docker work.
 */
function makeStreams(docker: FakeDocker, client: FakeClient): AgentStreamManager {
    const mcp = new McpDispatcher({
        sendRequest: async () => ({ ok: true, data: {} }),
        writeToContainer: () => true,
        resolveTarget: () => ({}),
        logger: silentLogger,
    })
    return new AgentStreamManager({
        docker: docker as never,
        client,
        logger: silentLogger,
        mcp,
    })
}

function makeHandler(docker: FakeDocker, client: FakeClient): AgentImageUpdateHandler {
    return new AgentImageUpdateHandler({
        docker: docker as never,
        status: new AgentStatusReporter(client, silentLogger),
        tracker: new OperationTracker(),
        streams: makeStreams(docker, client),
        logger: silentLogger,
    })
}

function makePayload(overrides: Partial<AgentImageUpdatePayload> = {}): AgentImageUpdatePayload {
    return {
        request_id: 'req-1',
        agent_id: 42,
        image_tag: 'ghcr.io/calltek/kj-agent-base:dev-local',
        restart_after: true,
        ...overrides,
    }
}

function statuses(client: FakeClient): AgentStatusReport[] {
    return client.pushes
        .filter((p) => p.event === 'agent:status')
        .map((p) => p.payload as AgentStatusReport)
}

function statusTransitions(client: FakeClient): AgentStatusReport['status'][] {
    const out: AgentStatusReport['status'][] = []
    for (const s of statuses(client)) {
        if (out[out.length - 1] !== s.status) out.push(s.status)
    }
    return out
}

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

function expectAck(ack: ControlCommandAck) {
    if (!ack.ok) {
        throw new Error(`expected ack.ok=true, got error=${JSON.stringify(ack.error)}`)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

let originalNodeEnv: string | undefined
beforeAll(() => {
    originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
})
afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv
})

describe('AgentImageUpdateHandler', () => {
    test('acks immediately and runs the pull in background', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        const ack = await handler.handle(makePayload())
        expectAck(ack)
        expect(ack.ok && (ack as { accepted: boolean }).accepted).toBe(true)

        // At ack-return time the pull may or may not have happened
        // depending on microtask order; we only care that the
        // background promise completes successfully.
        await waitForFinalStatus(client, 'STOPPED')
        expect(docker.pulled).toHaveLength(1)
        expect(docker.pulled[0]?.image_tag).toBe('ghcr.io/calltek/kj-agent-base:dev-local')
    })

    test('no existing container → pull and STOPPED', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'STOPPED')

        // No container to swap, so the supervisor neither stops nor
        // recreates anything.
        expect(docker.stopped).toEqual([])
        expect(docker.removed).toEqual([])
        expect(docker.recreated).toEqual([])

        const final = statuses(client).at(-1)
        expect(final?.status).toBe('STOPPED')
        expect(final?.last_action).toContain('image refreshed')
    })

    test('existing container + restart_after=false → stop + remove, STOPPED', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(makePayload({ restart_after: false }))
        await waitForFinalStatus(client, 'STOPPED')

        expect(docker.pulled).toHaveLength(1)
        expect(docker.stopped).toEqual([{ container_id: 'c-old', force: true }])
        expect(docker.removed).toEqual(['c-old'])
        expect(docker.recreated).toEqual([])

        const final = statuses(client).at(-1)
        expect(final?.status).toBe('STOPPED')
        expect(final?.container_id).toBeNull()
    })

    test('existing container + restart_after=true → recreate same name, attach, RUNNING', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        docker.recreate_returns = 'c-new'
        docker.next_inspect = {
            Config: { Env: ['KJ_SESSION_ID=session-uuid-1', 'OTHER=foo'] },
        }
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'RUNNING')

        expect(docker.pulled).toHaveLength(1)
        expect(docker.recreated).toEqual([
            {
                source_container: 'c-old',
                new_image_tag: 'ghcr.io/calltek/kj-agent-base:dev-local',
                keep_name: 'kj-agent-42',
            },
        ])
        // stopContainer / removeContainer are called *inside*
        // recreateContainerWithImage in the real client; the FakeDocker
        // here implements them as no-ops independent of recreate, so
        // we don't assert on stopped/removed for this path.

        const transitions = statusTransitions(client)
        expect(transitions[0]).toBe('SPAWNING') // pulling…
        expect(transitions).toContain('STOPPING') // swap
        expect(transitions.at(-1)).toBe('RUNNING')

        const final = statuses(client).at(-1)
        expect(final?.container_id).toBe('c-new')
        expect(final?.last_action).toContain('running on ghcr.io/calltek/kj-agent-base:dev-local')
    })

    test('graceful drain (KJ-22): sends drain, waits for exit, then swaps', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        docker.recreate_returns = 'c-new'
        // Running when the drain starts; the wrapper then "exits" → the next
        // poll sees it gone.
        let inspects = 0
        docker.inspect_fn = () => ({ State: { Running: inspects++ === 0 } })
        const client = new FakeClient()

        const controls: Array<{ agent_id: number; envelope: unknown }> = []
        const fakeStreams = {
            writeControl: (agent_id: number, envelope: unknown) => {
                controls.push({ agent_id, envelope })
                return true // a live stream IS attached → drain runs
            },
            detach: () => {},
        }
        const handler = new AgentImageUpdateHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            tracker: new OperationTracker(),
            streams: fakeStreams as never,
            logger: silentLogger,
        })

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'RUNNING')

        // The drain envelope was sent, then the swap happened.
        expect(controls).toEqual([{ agent_id: 42, envelope: { type: 'drain' } }])
        expect(docker.recreated).toHaveLength(1)
    })

    test('no live stream → drain skipped, swap proceeds anyway', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        const client = new FakeClient()
        const fakeStreams = {
            writeControl: () => false, // nothing attached
            detach: () => {},
        }
        const handler = new AgentImageUpdateHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            tracker: new OperationTracker(),
            streams: fakeStreams as never,
            logger: silentLogger,
        })

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'RUNNING')
        expect(docker.recreated).toHaveLength(1)
    })

    test('swap tracks the OLD container so its die is not reported as external', async () => {
        // Regression: the recreate kills + removes the old container. If that
        // isn't tracked, the events-watcher pushes a spurious "external die"
        // STOPPED that beats the RUNNING we push for the new container — a
        // healthy freshly-imaged agent shows as STOPPED (and a fleet rollout's
        // canary aborts). The fix tracks the old id across the whole swap.
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        docker.recreate_returns = 'c-new'
        docker.next_inspect = { Config: { Env: ['KJ_SESSION_ID=uuid'] } }
        const client = new FakeClient()
        const tracked: string[] = []
        const untracked: string[] = []
        const spyTracker = {
            track: (id: string) => tracked.push(id),
            untrack: (id: string) => untracked.push(id),
            isTracked: (id: string) => tracked.includes(id) && !untracked.includes(id),
        }
        const handler = new AgentImageUpdateHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            streams: makeStreams(docker, client),
            tracker: spyTracker as never,
            logger: silentLogger,
        })

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'RUNNING')

        // The OLD container was tracked during the swap and released after.
        expect(tracked).toContain('c-old')
        expect(untracked).toContain('c-old')
        // The NEW container is never tracked — a genuine crash of it must be
        // reported by the events-watcher.
        expect(tracked).not.toContain('c-new')
    })

    test('pull failure + cached locally → fallback, swap proceeds', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        docker.recreate_returns = 'c-new'
        docker.next_inspect = { Config: { Env: ['KJ_SESSION_ID=uuid'] } }
        docker.next_pull_error = new Error('unauthorized: registry')
        docker.image_exists_locally = true
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'RUNNING')

        expect(docker.exists_calls).toEqual(['ghcr.io/calltek/kj-agent-base:dev-local'])
        // The swap still ran with the cached image.
        expect(docker.recreated).toHaveLength(1)
        expect(statuses(client).at(-1)?.status).toBe('RUNNING')
    })

    test('pull failure + no cache → ERROR (container existed)', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        docker.next_pull_error = new Error('manifest unknown')
        docker.image_exists_locally = false
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'ERROR')

        expect(docker.recreated).toEqual([])
        const final = statuses(client).at(-1) as AgentStatusReport
        expect(final.status).toBe('ERROR')
        expect(final.container_id).toBe('c-old')
        expect(final.last_action).toContain('image pull failed')
    })

    test('pull failure + no cache + no container → STOPPED with failure detail', async () => {
        const docker = new FakeDocker()
        docker.next_pull_error = new Error('connection refused')
        docker.image_exists_locally = false
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'STOPPED')

        const final = statuses(client).at(-1) as AgentStatusReport
        expect(final.status).toBe('STOPPED')
        expect(final.container_id).toBeNull()
        expect(final.last_action).toContain('image pull failed')
    })

    test('recreate failure → ERROR (container existed, swap aborted)', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        docker.next_recreate_error = new Error('name in use')
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'ERROR')

        const final = statuses(client).at(-1) as AgentStatusReport
        expect(final.status).toBe('ERROR')
        expect(final.last_action).toContain('recreate failed')
    })

    test('propagates registry_credentials to pullImage when provided', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(
            makePayload({
                image_tag: 'ghcr.io/calltek/kj-agent-base:0.2.0',
                registry_credentials: {
                    registry: 'ghcr.io',
                    username: 'x-access-token',
                    password: 'ghp_test_token',
                },
                restart_after: false,
            })
        )
        await waitForFinalStatus(client, 'STOPPED')

        expect(docker.pulled).toHaveLength(1)
        expect(docker.pulled[0]?.auth).toEqual({
            username: 'x-access-token',
            password: 'ghp_test_token',
            serveraddress: 'ghcr.io',
        })
    })

    test('omits auth when registry_credentials is absent', async () => {
        const docker = new FakeDocker()
        const client = new FakeClient()
        const handler = makeHandler(docker, client)

        await handler.handle(makePayload({ restart_after: false }))
        await waitForFinalStatus(client, 'STOPPED')

        expect(docker.pulled).toHaveLength(1)
        expect(docker.pulled[0]?.auth).toBeUndefined()
    })
})

/**
 * The drain's limit comes from the control (`drain_timeout_ms`, kj-backend §6
 * 2026-09-19): a task can run for hours, and the drain used to cut anything
 * past 3 minutes. Absent → the old behaviour; `null` → no limit; a number →
 * that. The default is shrunk to a few ms here so "waits past the default"
 * is observable without waiting 3 minutes.
 */
describe('AgentImageUpdateHandler: drain limit from the control', () => {
    const DEFAULT_MS = 30
    const POLL_MS = 2

    /** A container that stays busy (running, same run) until `exit()` is called. */
    function busyContainer(docker: FakeDocker): { exit: () => void; restart: () => void } {
        let state: InspectInfo = {
            State: { Running: true, StartedAt: '2026-09-19T08:00:00Z' },
            RestartCount: 0,
        }
        docker.inspect_fn = () => state
        return {
            exit: () => {
                state = { State: { Running: false, StartedAt: '2026-09-19T08:00:00Z' } }
            },
            // What production actually sees: the wrapper exits and the restart
            // policy (unless-stopped) has Docker start it again ~100 ms later.
            restart: () => {
                state = {
                    State: { Running: true, StartedAt: '2026-09-19T09:30:00Z' },
                    RestartCount: 1,
                }
            },
        }
    }

    function makeDrainHandler(docker: FakeDocker, client: FakeClient) {
        const controls: unknown[] = []
        const handler = new AgentImageUpdateHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            tracker: new OperationTracker(),
            streams: {
                writeControl: (_agent_id: number, envelope: unknown) => {
                    controls.push(envelope)
                    return true
                },
                detach: () => {},
            } as never,
            logger: silentLogger,
            default_drain_timeout_ms: DEFAULT_MS,
            drain_poll_ms: POLL_MS,
        })
        return { handler, controls }
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    test('null → no limit: still waiting well past the default, then stops once the agent exits', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        const agent = busyContainer(docker)
        const client = new FakeClient()
        const { handler, controls } = makeDrainHandler(docker, client)

        const ack = await handler.handle(
            makePayload({ restart_after: false, drain_timeout_ms: null })
        )
        // The ack is out before the drain even starts: the control must not
        // read a long drain as a lost ack.
        expectAck(ack)
        expect(docker.stopped).toEqual([])

        // Five times the default and the agent is still mid-turn: nothing cut.
        await sleep(DEFAULT_MS * 5)
        expect(controls).toEqual([{ type: 'drain' }])
        expect(docker.stopped).toEqual([])
        expect(statuses(client).some((s) => s.status === 'STOPPED')).toBe(false)
        expect(statuses(client).at(-1)?.last_action).toContain('waiting for the current turn')

        agent.exit()
        await waitForFinalStatus(client, 'STOPPED')
        expect(docker.stopped).toEqual([{ container_id: 'c-old', force: true }])
        expect(docker.removed).toEqual(['c-old'])
    })

    test('the restart-policy restart counts as the exit (the container is never seen stopped)', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        const agent = busyContainer(docker)
        const client = new FakeClient()
        const { handler } = makeDrainHandler(docker, client)

        await handler.handle(makePayload({ restart_after: false, drain_timeout_ms: null }))
        await sleep(DEFAULT_MS * 2)
        expect(docker.stopped).toEqual([])

        // Running again, with a new start: without this check a drain with no
        // limit would wait for ever on an agent that already finished.
        agent.restart()
        await waitForFinalStatus(client, 'STOPPED')
        expect(docker.stopped).toEqual([{ container_id: 'c-old', force: true }])
    })

    test('a number caps the drain at that, not at the default', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        busyContainer(docker) // never exits
        const client = new FakeClient()
        const handler = new AgentImageUpdateHandler({
            docker: docker as never,
            status: new AgentStatusReporter(client, silentLogger),
            tracker: new OperationTracker(),
            streams: { writeControl: () => true, detach: () => {} } as never,
            logger: silentLogger,
            // A default this long would time the test out: only the number
            // from the control can end the drain in time.
            default_drain_timeout_ms: 60_000,
            drain_poll_ms: POLL_MS,
        })

        const started = Date.now()
        await handler.handle(makePayload({ restart_after: false, drain_timeout_ms: 40 }))
        await waitForFinalStatus(client, 'STOPPED')

        expect(Date.now() - started).toBeGreaterThanOrEqual(40)
        // Forced: the agent never exited, so the stop cuts it.
        expect(docker.stopped).toEqual([{ container_id: 'c-old', force: true }])
    })

    test('absent → the default still applies on a swap (older control)', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        docker.recreate_returns = 'c-new'
        busyContainer(docker) // never exits
        const client = new FakeClient()
        const { handler, controls } = makeDrainHandler(docker, client)

        await handler.handle(makePayload({ restart_after: true }))
        await waitForFinalStatus(client, 'RUNNING')

        expect(controls).toEqual([{ type: 'drain' }])
        expect(docker.recreated).toHaveLength(1)
    })

    test('absent + restart_after=false → stops straight away, as before (older control)', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        busyContainer(docker)
        const client = new FakeClient()
        const { handler, controls } = makeDrainHandler(docker, client)

        await handler.handle(makePayload({ restart_after: false }))
        await waitForFinalStatus(client, 'STOPPED')

        // That control only waits 3 min for the STOPPED before respawning:
        // draining here could leave the agent updated but stopped.
        expect(controls).toEqual([])
        expect(docker.stopped).toEqual([{ container_id: 'c-old', force: true }])
    })

    test('0 → no wait: drain is asked for, and the stop follows at once', async () => {
        const docker = new FakeDocker()
        docker.containers = [{ container_id: 'c-old', agent_id: 42 }]
        busyContainer(docker)
        const client = new FakeClient()
        const { handler, controls } = makeDrainHandler(docker, client)

        await handler.handle(makePayload({ restart_after: false, drain_timeout_ms: 0 }))
        await waitForFinalStatus(client, 'STOPPED')

        expect(controls).toEqual([{ type: 'drain' }])
        expect(docker.stopped).toEqual([{ container_id: 'c-old', force: true }])
    })
})

// Ack returned by `handle()` is a typed union; this helper narrows it
// for the assertions above without ts-expect-error.
void (null as unknown as WsErrorPayload)
