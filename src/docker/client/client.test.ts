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
            stop: async () => undefined,
            kill: async () => undefined,
            remove: async () => undefined,
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

describe('recreateContainerWithImage', () => {
    test('keeps runtime env but drops PATH so the new image PATH wins', async () => {
        const fake = new FakeDocker()
        fake.containers['kj-agent-7'] = {
            Config: {
                Env: [
                    'PATH=/old/image/path:/usr/bin',
                    'KJ_AGENT_ID=7',
                    'HOME=/home/agent',
                    'CLAUDE_CODE_OAUTH_TOKEN=secret',
                ],
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
        await docker.recreateContainerWithImage({
            source_container: 'kj-agent-7',
            new_image_tag: 'ghcr.io/calltek/kj-agent-flex:0.2.0',
            keep_name: 'kj-agent-7',
        })

        const env: string[] = fake.createdSpec.Env
        // Runtime env preserved…
        expect(env).toContain('KJ_AGENT_ID=7')
        expect(env).toContain('HOME=/home/agent')
        expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=secret')
        // …but the stale image PATH is gone (docker merges the new image's ENV).
        expect(env.some((e) => e.startsWith('PATH='))).toBe(false)
    })
})

describe('runContainer — privileged networking (KJ-156)', () => {
    test('network_privileged adds CAP_NET_ADMIN + /dev/net/tun, keeps the lockdown', async () => {
        const fake = new FakeDocker()
        await makeDocker(fake).runContainer({
            image_tag: 'ghcr.io/calltek/kj-agent-flex:0.2.0',
            name: 'kj-agent-9',
            env: {},
            labels: {},
            resources: { memory_mb: 512, cpu: 1 },
            network_privileged: true,
        })
        const hc = fake.createdSpec.HostConfig
        expect(hc.CapDrop).toEqual(['ALL'])
        expect(hc.CapAdd).toEqual(['NET_ADMIN'])
        expect(hc.Devices).toEqual([
            {
                PathOnHost: '/dev/net/tun',
                PathInContainer: '/dev/net/tun',
                CgroupPermissions: 'rwm',
            },
        ])
        expect(hc.SecurityOpt).toEqual(['no-new-privileges'])
    })

    test('the default container is locked down (no CapAdd / Devices)', async () => {
        const fake = new FakeDocker()
        await makeDocker(fake).runContainer({
            image_tag: 'img',
            name: 'kj-agent-1',
            env: {},
            labels: {},
            resources: { memory_mb: 512, cpu: 1 },
        })
        const hc = fake.createdSpec.HostConfig
        expect(hc.CapDrop).toEqual(['ALL'])
        expect(hc.CapAdd).toBeUndefined()
        expect(hc.Devices).toBeUndefined()
        expect(hc.SecurityOpt).toEqual(['no-new-privileges'])
    })
})

describe('recreateContainerWithImage — security posture (KJ-156)', () => {
    const baseHost = {
        Binds: [],
        Mounts: [],
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: 'bridge',
        GroupAdd: [],
        Memory: 0,
        NanoCpus: 0,
    }

    test('re-applies CapDrop ALL + no-new-privileges and carries the source CapAdd/Devices', async () => {
        const fake = new FakeDocker()
        fake.containers['kj-agent-9'] = {
            Config: { Env: [], Cmd: null, Entrypoint: null, Labels: {} },
            HostConfig: {
                ...baseHost,
                CapAdd: ['NET_ADMIN'],
                Devices: [
                    {
                        PathOnHost: '/dev/net/tun',
                        PathInContainer: '/dev/net/tun',
                        CgroupPermissions: 'rwm',
                    },
                ],
            },
        }
        await makeDocker(fake).recreateContainerWithImage({
            source_container: 'kj-agent-9',
            new_image_tag: 'img:new',
            keep_name: 'kj-agent-9',
        })
        const hc = fake.createdSpec.HostConfig
        // hardening re-applied (was silently dropped before)…
        expect(hc.CapDrop).toEqual(['ALL'])
        expect(hc.SecurityOpt).toEqual(['no-new-privileges'])
        // …and the privileged networking survives the recreate.
        expect(hc.CapAdd).toEqual(['NET_ADMIN'])
        expect(hc.Devices?.[0]?.PathInContainer).toBe('/dev/net/tun')
    })

    test('a non-privileged source recreates locked down (no CapAdd/Devices)', async () => {
        const fake = new FakeDocker()
        fake.containers['kj-agent-1'] = {
            Config: { Env: [], Cmd: null, Entrypoint: null, Labels: {} },
            HostConfig: { ...baseHost },
        }
        await makeDocker(fake).recreateContainerWithImage({
            source_container: 'kj-agent-1',
            new_image_tag: 'img:new',
            keep_name: 'kj-agent-1',
        })
        const hc = fake.createdSpec.HostConfig
        expect(hc.CapDrop).toEqual(['ALL'])
        expect(hc.SecurityOpt).toEqual(['no-new-privileges'])
        expect(hc.CapAdd).toBeUndefined()
        expect(hc.Devices).toBeUndefined()
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
