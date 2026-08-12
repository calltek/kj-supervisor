import { afterEach, describe, expect, test } from 'bun:test'
import os from 'node:os'

import { KJLogger } from '../../logger'
import { KJDocker, buildBackupScript } from './client'

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

describe('backupVolume — multipart contract guard', () => {
    // The helper cuts chunks with `dd bs=1048576 count=$((KJ_PART_SIZE / 1048576))`,
    // which truncates on non-multiples. If the control ever hands us a
    // part_size_bytes that isn't 1 MiB-aligned, every chunk would be a few
    // bytes short of where the next `skip` expects and the tarball would
    // land in R2 with hidden holes — no error from curl, no ETag mismatch.
    // Better to fail loud here than silently upload a corrupted backup.
    test('rejects part_size_bytes that is not a multiple of 1 MiB', async () => {
        const docker = makeDocker(new FakeDocker())
        await expect(
            docker.backupVolume('kj-agent-42-home', 'https://r2/put', {
                upload_id: 'up-1',
                part_urls: ['https://r2/part1'],
                part_size_bytes: 536_870_913, // 512 MiB + 1 byte
                single_put_limit_bytes: 5_364_514_816,
            })
        ).rejects.toThrow(/multiple of 1 MiB/)
    })

    test('rejects part_size_bytes that is zero (would divide by zero in helper)', async () => {
        // 0 % 1 MiB === 0, so the alignment guard alone lets this through and
        // the helper crashes with a cryptic "division by zero" instead of the
        // explicit message the guard is here for.
        const docker = makeDocker(new FakeDocker())
        await expect(
            docker.backupVolume('kj-agent-42-home', 'https://r2/put', {
                upload_id: 'up-1',
                part_urls: ['https://r2/part1'],
                part_size_bytes: 0,
                single_put_limit_bytes: 5_364_514_816,
            })
        ).rejects.toThrow(/positive number of bytes/)
    })

    test('rejects part_size_bytes that is negative', async () => {
        const docker = makeDocker(new FakeDocker())
        await expect(
            docker.backupVolume('kj-agent-42-home', 'https://r2/put', {
                upload_id: 'up-1',
                part_urls: ['https://r2/part1'],
                part_size_bytes: -1024,
                single_put_limit_bytes: 5_364_514_816,
            })
        ).rejects.toThrow(/positive number of bytes/)
    })

    test('accepts part_size_bytes that is a multiple of 1 MiB (would call docker)', async () => {
        // We don't want to spin a real container here — we just want to
        // confirm the guard doesn't reject a valid size. The call will
        // fail downstream in FakeDocker, but NOT on the guard.
        const docker = makeDocker(new FakeDocker())
        let err: Error | undefined
        try {
            await docker.backupVolume('kj-agent-42-home', 'https://r2/put', {
                upload_id: 'up-1',
                part_urls: ['https://r2/part1'],
                part_size_bytes: 536_870_912, // 512 MiB exact
                single_put_limit_bytes: 5_364_514_816,
            })
        } catch (e) {
            err = e as Error
        }
        expect(err).toBeDefined()
        // The guard must NOT be the thing that fired — anything else is fine.
        expect(err?.message).not.toMatch(/multiple of 1 MiB/)
    })
})

/**
 * The Docker socket is the whole machine: a container that can reach it can
 * start another container as root, mount the host filesystem, and read every
 * other agent's home. The supervisor needs it — that's its job — but an AGENT
 * must never see it (kj-supervisor#12).
 *
 * Nothing mounts it today. This is here because the hardening around these two
 * paths already drifted apart once (#13): the recreate silently dropped
 * `CapDrop: ALL`, and nobody noticed until someone read both blocks side by
 * side. The socket is the one thing where "nobody noticed" would be a machine
 * handed over, so it gets a test that fails loudly instead of a comment asking
 * to be careful.
 *
 * Both paths are covered, and the recreate one carries the socket in its SOURCE
 * container on purpose: the recreate copies mounts from what was there, so
 * "the source had it" is exactly how it would sneak in.
 */
describe('un contenedor de agente NUNCA ve el socket de Docker (#12)', () => {
    const DOCKER_SOCKET = '/var/run/docker.sock'

    /** Todo lo que el contenedor acabaría viendo, venga por donde venga. */
    function mountedPaths(hc: {
        Binds?: string[] | null
        Mounts?: { Source?: string; Target?: string }[] | null
        Devices?: { PathOnHost?: string }[] | null
    }): string[] {
        return [
            ...(hc.Binds ?? []),
            ...(hc.Mounts ?? []).flatMap((m) => [m.Source ?? '', m.Target ?? '']),
            ...(hc.Devices ?? []).map((d) => d.PathOnHost ?? ''),
        ]
    }

    test('al crearlo', async () => {
        const fake = new FakeDocker()
        await makeDocker(fake).runContainer({
            image_tag: 'img',
            name: 'kj-agent-1',
            env: {},
            labels: {},
            resources: { memory_mb: 512, cpu: 1 },
            home_volume_name: 'kj-agent-1-home',
            network_privileged: true, // el caso con más permisos que existe
        })

        const paths = mountedPaths(fake.createdSpec.HostConfig)
        expect(paths.some((p) => p.includes(DOCKER_SOCKET))).toBe(false)
    })

    test('y al recrearlo, aunque el contenedor de origen lo tuviera', async () => {
        // Así es como se colaría: el recreate copia los montajes del origen, de
        // modo que un contenedor tocado a mano se lo pasaría al siguiente y de
        // ahí a todos los que vinieran después.
        const fake = new FakeDocker()
        fake.containers['kj-agent-9'] = {
            Config: { Env: [], Cmd: null, Entrypoint: null, Labels: {} },
            HostConfig: {
                Binds: [`${DOCKER_SOCKET}:${DOCKER_SOCKET}`],
                Mounts: [],
                RestartPolicy: { Name: 'unless-stopped' },
                NetworkMode: 'bridge',
                GroupAdd: [],
                Memory: 0,
                NanoCpus: 0,
            },
        }

        await makeDocker(fake).recreateContainerWithImage({
            source_container: 'kj-agent-9',
            new_image_tag: 'img:new',
            keep_name: 'kj-agent-9',
        })

        const paths = mountedPaths(fake.createdSpec.HostConfig)
        expect(paths.some((p) => p.includes(DOCKER_SOCKET))).toBe(false)
    })
})

describe('buildBackupScript — qué entra en la copia y qué no (#391)', () => {
    const script = buildBackupScript()

    test('las bases SQLite se copian con el método que aguanta un escritor', () => {
        // Copiar el fichero a pelo mientras alguien escribe da una base rota, y
        // en la flota hay una Chroma de 1 GB que se escribe sola cuando el
        // agente indexa. `VACUUM INTO` respeta el bloqueo y produce una copia
        // consistente sin parar a nadie.
        expect(script).toContain('VACUUM INTO')
        expect(script).toContain('*.sqlite3')
        // Y las copias temporales no se quedan en el volumen del cliente.
        expect(script).toContain('-name "*.kjbackup" -delete')
    })

    test('se copia TODO: nada de exclusiones', () => {
        // Excluir node_modules/.venv recortaba un cuarto de cada copia, y se
        // revirtió a propósito: la restauración pasaba a depender de que
        // existiera un fichero de dependencias, y en la flota hay un entorno de
        // Python de 1,6 GB sin ninguno, del que depende la biblioteca de un
        // agente. Una copia que sólo sirve si alguien hizo los deberes no es
        // una copia.
        expect(script).not.toContain('--exclude')
        expect(script).toContain('tar -C /v -czf /tmp/b.tgz .')
    })

    test('no se copian en caliente las bases de las dependencias', () => {
        // Una SQLite dentro de node_modules o de un .venv es de una
        // dependencia: se copia tal cual dentro del tar, pero no merece una
        // pasada de VACUUM que puede tardar sobre una base de un giga.
        expect(script).toContain('grep -v "/node_modules/"')
        expect(script).toContain('grep -v "/.venv/"')
    })
})
