import { afterEach, describe, expect, test } from 'bun:test'
import os from 'node:os'

import { KJLogger } from '../../logger'
import { KJDocker } from './client'

const silentLogger = KJLogger.create('error')

/**
 * Minimal dockerode stub. `containers` maps a name/id to the object its
 * `.inspect()` resolves to; a missing key makes `.inspect()` throw (the real
 * "no such container" 404).
 */
class FakeDocker {
    public containers: Record<string, unknown> = {}
    public createdSpec: any = null

    getContainer(nameOrId: string) {
        return {
            inspect: async () => {
                if (!(nameOrId in this.containers)) throw new Error('no such container')
                return this.containers[nameOrId]
            },
            rename: async () => undefined,
            start: async () => undefined,
        }
    }

    async createContainer(spec: any) {
        this.createdSpec = spec
        return { id: 'new-container-id', start: async () => undefined }
    }
}

function makeDocker(fake: FakeDocker): KJDocker {
    return new KJDocker(silentLogger, fake as never)
}

afterEach(() => {
    delete process.env.KJ_OWN_CONTAINER
})

describe('cloneContainerWithNewImage', () => {
    test('injects KJ_OWN_CONTAINER with the new name and strips a stale one', async () => {
        const fake = new FakeDocker()
        fake.containers['kj-supervisor'] = {
            Config: {
                Env: ['FOO=1', 'KJ_OWN_CONTAINER=kj-supervisor-new-OLD'],
                Cmd: null,
                Entrypoint: null,
                Labels: {},
            },
            HostConfig: {
                Binds: [],
                Mounts: [],
                RestartPolicy: { Name: 'unless-stopped' },
                NetworkMode: 'host',
                GroupAdd: [],
                Memory: 0,
                NanoCpus: 0,
            },
        }

        const docker = makeDocker(fake)
        await docker.cloneContainerWithNewImage({
            source_container: 'kj-supervisor',
            new_image_tag: 'ghcr.io/calltek/kj-supervisor:latest',
            new_name: 'kj-supervisor-new-123',
        })

        const env: string[] = fake.createdSpec.Env
        expect(env).toContain('FOO=1')
        expect(env).toContain('KJ_OWN_CONTAINER=kj-supervisor-new-123')
        // the stale value inherited from the source must be gone
        expect(env.filter((e) => e.startsWith('KJ_OWN_CONTAINER='))).toEqual([
            'KJ_OWN_CONTAINER=kj-supervisor-new-123',
        ])
        expect(fake.createdSpec.name).toBe('kj-supervisor-new-123')
    })
})

describe('getOwnContainerName', () => {
    test('prefers KJ_OWN_CONTAINER (reliable under --network host)', async () => {
        process.env.KJ_OWN_CONTAINER = 'kj-supervisor-new-9'
        const docker = makeDocker(new FakeDocker())
        expect(await docker.getOwnContainerName()).toBe('kj-supervisor-new-9')
    })

    test('falls back to hostname-based inspect when env is absent', async () => {
        const fake = new FakeDocker()
        fake.containers[os.hostname()] = { Name: '/some-container' }
        const docker = makeDocker(fake)
        expect(await docker.getOwnContainerName()).toBe('some-container')
    })

    test('returns null when env absent and inspect fails (host networking)', async () => {
        // os.hostname() is the HOST name under --network host → not a container.
        const docker = makeDocker(new FakeDocker())
        expect(await docker.getOwnContainerName()).toBeNull()
    })
})

describe('containerExists', () => {
    test('true when present, false when absent', async () => {
        const fake = new FakeDocker()
        fake.containers['kj-supervisor'] = { Name: '/kj-supervisor' }
        const docker = makeDocker(fake)
        expect(await docker.containerExists('kj-supervisor')).toBe(true)
        expect(await docker.containerExists('kj-supervisor-new-123')).toBe(false)
    })
})
