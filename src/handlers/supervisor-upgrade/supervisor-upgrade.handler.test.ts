import { describe, expect, test } from 'bun:test'

import { KJLogger } from '../../logger'
import { SupervisorUpgradeHandler } from './supervisor-upgrade.handler'

const silentLogger = KJLogger.create('error')

class FakeDocker {
    public pulled: string[] = []
    public clones: Array<{ source: string; image: string; name: string }> = []
    public next_pull_error: Error | null = null
    public next_clone_error: Error | null = null

    async pullImage(image_tag: string): Promise<void> {
        if (this.next_pull_error) throw this.next_pull_error
        this.pulled.push(image_tag)
    }

    async cloneContainerWithNewImage(opts: {
        source_container: string
        new_image_tag: string
        new_name: string
    }): Promise<string> {
        if (this.next_clone_error) throw this.next_clone_error
        this.clones.push({
            source: opts.source_container,
            image: opts.new_image_tag,
            name: opts.new_name,
        })
        return `new-container-${this.clones.length}`
    }
}

const TARGET = 'ghcr.io/calltek/kj-agent-supervisor:1.5.0'

function payload(target = TARGET) {
    return { target_image_tag: target, reason: 'protocol version mismatch' }
}

describe('SupervisorUpgradeHandler', () => {
    test('refuses to act without KJ_SUPERVISOR_CONTAINER', async () => {
        const docker = new FakeDocker()
        let exited = false
        const handler = new SupervisorUpgradeHandler({
            docker: docker as never,
            logger: silentLogger,
            supervisor_container: null,
            exit_fn: () => {
                exited = true
            },
            handover_grace_ms: 1,
        })

        await handler.handle(payload())
        // Allow the grace timer to fire if it had been scheduled.
        await new Promise((r) => setTimeout(r, 10))

        expect(docker.pulled).toEqual([])
        expect(docker.clones).toEqual([])
        expect(exited).toBe(false)
    })

    test('happy path: pulls, clones, schedules exit', async () => {
        const docker = new FakeDocker()
        const exit_calls: number[] = []
        const handler = new SupervisorUpgradeHandler({
            docker: docker as never,
            logger: silentLogger,
            supervisor_container: 'kj-agent-supervisor',
            exit_fn: (code) => {
                exit_calls.push(code)
            },
            handover_grace_ms: 5,
        })

        await handler.handle(payload())

        expect(docker.pulled).toEqual([TARGET])
        expect(docker.clones).toHaveLength(1)
        expect(docker.clones[0]?.source).toBe('kj-agent-supervisor')
        expect(docker.clones[0]?.image).toBe(TARGET)
        expect(docker.clones[0]?.name).toMatch(/^kj-agent-supervisor-new-\d+$/)

        // Wait past the grace period.
        await new Promise((r) => setTimeout(r, 25))
        expect(exit_calls).toEqual([0])
    })

    test('pull failure aborts without spawning anything or exiting', async () => {
        const docker = new FakeDocker()
        docker.next_pull_error = new Error('registry timed out')
        let exited = false
        const handler = new SupervisorUpgradeHandler({
            docker: docker as never,
            logger: silentLogger,
            supervisor_container: 'kj-agent-supervisor',
            exit_fn: () => {
                exited = true
            },
            handover_grace_ms: 1,
        })

        await handler.handle(payload())
        await new Promise((r) => setTimeout(r, 10))

        expect(docker.clones).toEqual([])
        expect(exited).toBe(false)
    })

    test('clone failure aborts without exiting', async () => {
        const docker = new FakeDocker()
        docker.next_clone_error = new Error('image not pulled')
        let exited = false
        const handler = new SupervisorUpgradeHandler({
            docker: docker as never,
            logger: silentLogger,
            supervisor_container: 'kj-agent-supervisor',
            exit_fn: () => {
                exited = true
            },
            handover_grace_ms: 1,
        })

        await handler.handle(payload())
        await new Promise((r) => setTimeout(r, 10))

        expect(docker.pulled).toEqual([TARGET])
        expect(exited).toBe(false)
    })

    test('ignores duplicate events while one upgrade is in flight', async () => {
        const docker = new FakeDocker()
        const handler = new SupervisorUpgradeHandler({
            docker: docker as never,
            logger: silentLogger,
            supervisor_container: 'kj-agent-supervisor',
            exit_fn: () => undefined,
            handover_grace_ms: 60_000, // long, so the in_progress flag stays set
        })

        await handler.handle(payload())
        await handler.handle(payload('ghcr.io/different:1.6.0'))

        expect(docker.pulled).toEqual([TARGET])
        expect(docker.clones).toHaveLength(1)
    })
})
