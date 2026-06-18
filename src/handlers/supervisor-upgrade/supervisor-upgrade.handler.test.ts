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

const TARGET = 'ghcr.io/calltek/kj-supervisor:1.5.0'

function payload(target = TARGET) {
    return { target_image_tag: target, reason: 'protocol version mismatch' }
}

function makeHandler(docker: FakeDocker, supervisor_container: string | null = 'kj-supervisor') {
    return new SupervisorUpgradeHandler({
        docker: docker as never,
        logger: silentLogger,
        supervisor_container,
    })
}

describe('SupervisorUpgradeHandler', () => {
    test('refuses to act without KJ_SUPERVISOR_CONTAINER', async () => {
        const docker = new FakeDocker()
        await makeHandler(docker, null).handle(payload())
        expect(docker.pulled).toEqual([])
        expect(docker.clones).toEqual([])
    })

    test('happy path: pulls + clones, and does NOT exit (the clone finishes the swap)', async () => {
        const docker = new FakeDocker()
        // process.exit would kill the test runner — assert it is never called.
        const realExit = process.exit
        let exited = false
        // @ts-expect-error override for the test
        process.exit = () => {
            exited = true
        }
        try {
            await makeHandler(docker).handle(payload())
        } finally {
            process.exit = realExit
        }

        expect(docker.pulled).toEqual([TARGET])
        expect(docker.clones).toHaveLength(1)
        expect(docker.clones[0]?.source).toBe('kj-supervisor')
        expect(docker.clones[0]?.image).toBe(TARGET)
        expect(docker.clones[0]?.name).toMatch(/^kj-supervisor-new-\d+$/)
        // The OLD supervisor must keep running — the clone removes it on its
        // first handshake (a self-exit would get revived by unless-stopped).
        expect(exited).toBe(false)
    })

    test('pull failure aborts without cloning', async () => {
        const docker = new FakeDocker()
        docker.next_pull_error = new Error('registry timed out')
        await makeHandler(docker).handle(payload())
        expect(docker.clones).toEqual([])
    })

    test('clone failure aborts cleanly (old keeps running)', async () => {
        const docker = new FakeDocker()
        docker.next_clone_error = new Error('image not pulled')
        await makeHandler(docker).handle(payload())
        expect(docker.pulled).toEqual([TARGET])
        expect(docker.clones).toEqual([])
    })

    test('ignores duplicate events while one upgrade is in flight', async () => {
        const docker = new FakeDocker()
        const handler = makeHandler(docker)
        await handler.handle(payload())
        await handler.handle(payload('ghcr.io/different:1.6.0'))
        expect(docker.pulled).toEqual([TARGET])
        expect(docker.clones).toHaveLength(1)
    })
})
