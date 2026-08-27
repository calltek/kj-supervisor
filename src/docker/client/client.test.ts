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

describe('buildBackupScript — copia consistente de las bases (#391)', () => {
    const script = buildBackupScript()

    test('NO escribe dentro del volumen, que va montado en solo lectura', () => {
        // El fallo que cazó la revisión de seguridad: la primera versión hacía
        // `VACUUM INTO` a un fichero dentro de /v. El ayudante monta ese
        // volumen READ-ONLY, así que fallaba SIEMPRE — y el `2>/dev/null` se lo
        // tragaba: copia en verde, sin una sola base consistente, y el fallo
        // sólo visible el día de restaurar.
        expect(script).not.toMatch(/\.backup\s+\/v\//)
        expect(script).not.toMatch(/VACUUM INTO\s+'?\/v\//)
        expect(script).toContain('.backup /tmp/kjdb/copia-$SEQ')
    })

    test('una copia que falla TUMBA el backup, no lo silencia', () => {
        // La otra mitad del hallazgo: mientras un fallo fuera un aviso en
        // stderr, el sistema podía mentir sobre el estado de las copias.
        expect(script).toContain('exit 7')
        expect(script).toContain('/tmp/kjdb.failed')
        // Y en concreto: la línea de la copia no lleva silenciador.
        const copia = script.split('\n').find((l) => l.includes('.backup /tmp/kjdb/'))
        expect(copia).toBeDefined()
        expect(copia).not.toContain('2>/dev/null')
        expect(copia).not.toContain('|| echo')
    })

    test('el destino de la copia es un contador, no la ruta del fichero', () => {
        // El nombre del fichero lo controla el agente y el cliente de sqlite3
        // ejecuta su argumento como script entero: interpolar la ruta permitía
        // encadenar sentencias, y un simple apóstrofo rompía la copia.
        expect(script).toContain('copia-$SEQ')
        expect(script).not.toMatch(/\.backup[^\n]*\$DB[^\n]*"/)
    })

    test('la copia va DESPUÉS del volumen en el tar', () => {
        // Al extraer, la última entrada de una ruta repetida gana. Ese orden es
        // lo que hace que una restauración se quede con la versión consistente
        // sin que nadie tenga que elegir cuál era la buena.
        const tar = script.split('\n').find((l) => l.startsWith('tar -czf'))
        expect(tar).toContain('tar -czf /tmp/b.tgz -C /v . -C /tmp/kjdb .')
    })

    test('a file changing under tar does NOT lose the backup', () => {
        // GNU tar exits 1 when a file changed/vanished while it read it — the
        // normal weather of a RUNNING agent writing to its volume. Under a
        // bare `set -e` that warning killed the whole backup (seen live on
        // Soki's volume, 2026-08-27). Exit 2+ (truncated archive) stays fatal.
        const tar = script.split('\n').find((l) => l.startsWith('tar -czf'))
        expect(tar).toContain('|| {')
        expect(script).toContain('if [ "$RC" -ge 2 ]; then exit "$RC"; fi')
    })

    test('las copias nacen privadas', () => {
        // `.backup` no hereda el modo del origen: sin esto, la copia íntegra de
        // una base 0600 quedaba legible por cualquiera durante toda la ventana.
        expect(script).toContain('umask 077')
    })

    test('se salta lo que no es SQLite de verdad y lo de las dependencias', () => {
        expect(script).toContain('SQLite format 3')
        expect(script).toContain('-not -path "*/node_modules/*"')
        expect(script).toContain('-not -path "*/.venv/*"')
    })

    test('recorre los ficheros con -exec, no parseando la salida de find', () => {
        // Un nombre con un salto de línea rompe cualquier bucle que parsee.
        expect(script).toContain('-exec sh -c')
        expect(script).not.toMatch(/find[^\n]*\|[^\n]*while read/)
    })

    test('nothing can die MUTE under set -e (night of 2026-08-27)', () => {
        // NOVA died as "exited 1:" with not one line of output. Two silencers
        // conspired: apk swallowed stderr, and the sidecar AND-list leaked a
        // status 1 out of the inner shell that find propagated into `set -e`.
        // apk may hide its progress (stdout) but never its errors (stderr).
        const apk = script.split('\n').find((l) => l.startsWith('apk add'))
        expect(apk).toBeDefined()
        expect(apk).not.toContain('2>&1')
        // The sidecar seeding is an `if` (exits 0 when the file is absent),
        // not a bare `[ -f … ] && …` whose status-1 becomes the loop's.
        expect(script).toContain('if [ -f "$DB$SUF" ]; then : > "/tmp/kjdb/$REL$SUF"; fi')
        expect(script).not.toContain('[ -f "$DB$SUF" ] && :')
        // And if find still fails, it says so instead of dying bare.
        expect(script).toMatch(/' _ \{\} \+ \|\| \{ echo .+>&2; exit 9; \}/)
    })

    test('a WAL database on the read-only mount falls back to immutable', () => {
        // `.backup` cannot open a WAL database on a read-only filesystem
        // (Soki's `.aws/cli/cache/session.db`, night of 2026-08-27). The
        // fallback opens it with `immutable=1` — but ONLY when no -wal/-shm
        // sidecars exist, i.e. the file is checkpointed and nobody is
        // mid-write. With sidecars present the copy stays failed and loud.
        expect(script).toContain('sqlite3 "file:$DB?immutable=1"')
        const fallbackAt = script.indexOf('immutable=1')
        const guardAt = script.indexOf('[ ! -f "$DB-wal" ] && [ ! -f "$DB-shm" ]')
        expect(guardAt).toBeGreaterThan(-1)
        expect(guardAt).toBeLessThan(fallbackAt)
    })

    test('a name with URI metacharacters never reaches the file: URI', () => {
        // In `file:` the name stops being an opaque path: `?` smuggles query
        // parameters (`x.db?immutable=0` would void the very flag the
        // fallback depends on) and `%XX` percent-decodes into a DIFFERENT
        // path than the one the guards validated. The file name is the
        // agent's, so any of `?`/`#`/`%` skips the fallback and the file
        // lands in kjdb.failed — where it landed before the fallback existed.
        const caseAt = script.indexOf('case "$DB" in (*"?"*|*"#"*|*"%"*) false ;; (*) true ;; esac')
        const uriAt = script.indexOf('sqlite3 "file:$DB?immutable=1"')
        expect(caseAt).toBeGreaterThan(-1)
        expect(caseAt).toBeLessThan(uriAt)
        // A newline in the name (representable in no URI) is rejected too:
        // the name must equal itself with newlines stripped, and the command
        // substitution eating a TRAILING newline makes that case fail as
        // well.
        const nlAt = script.indexOf('[ "$DB" = "$(printf %s "$DB" | tr -d "\\n")" ]')
        expect(nlAt).toBeGreaterThan(-1)
        expect(nlAt).toBeLessThan(uriAt)
    })

    test('the immutable copy only counts verified', () => {
        // `immutable=1` skips locking, so a writer sneaking in between the
        // sidecar check and the copy would corrupt it with NO error. The copy
        // must pass integrity_check AND find the sidecars still absent
        // afterwards; otherwise it goes to kjdb.failed like any other miss.
        const uriAt = script.indexOf('sqlite3 "file:$DB?immutable=1"')
        const checkAt = script.indexOf('PRAGMA integrity_check')
        const recheckAt = script.indexOf('[ ! -f "$DB-journal" ]; }', uriAt)
        expect(checkAt).toBeGreaterThan(uriAt)
        expect(recheckAt).toBeGreaterThan(checkAt)
    })

    test('a hot rollback journal blocks the fallback and gets blanked', () => {
        // `immutable=1` also disables hot-journal replay — and a hot
        // `-journal` is the OTHER reason the normal `.backup` fails on a
        // read-only mount. integrity_check cannot catch it (a half-rolled
        // transaction breaks atomicity, not page structure), so `-journal`
        // must sit in both existence guards…
        const first = script.indexOf(
            '[ ! -f "$DB-wal" ] && [ ! -f "$DB-shm" ] && [ ! -f "$DB-journal" ]'
        )
        const second = script.indexOf(
            '[ ! -f "$DB-wal" ] && [ ! -f "$DB-shm" ] && [ ! -f "$DB-journal" ]',
            first + 1
        )
        expect(first).toBeGreaterThan(-1)
        expect(second).toBeGreaterThan(first)
        // …and travel blanked in the tar, like -wal/-shm: a journal from
        // another instant would be replayed on first open of the restored
        // copy.
        expect(script).toContain('for SUF in -wal -shm -journal; do')
    })

    test('the tar warning leaves a marker the control side can keep', () => {
        // The stderr line dies with the helper on success (nobody reads green
        // logs); the line-anchored marker is what backupVolume() picks up.
        expect(script).toContain('echo "KJ_TAR_WARN=1"')
    })
})

describe('backupVolume — markers parse from stdout only', () => {
    // With tar exit 1 non-fatal, stderr reaches the logs on SUCCESS — and
    // stderr carries agent-named file paths that sqlite3 prints RAW, newlines
    // included, so the agent can forge ENTIRE lines there (an anchored regex
    // over the mixed string is not a defense). The helper is the only writer
    // on its stdout, so markers parse from the frame-demuxed stdout stream
    // and from nothing else.
    function frame(type: 1 | 2, text: string): Buffer {
        const payload = Buffer.from(text)
        const header = Buffer.alloc(8)
        header[0] = type
        header.writeUInt32BE(payload.length, 4)
        return Buffer.concat([header, payload])
    }

    function helperDocker(frames: Buffer[]): KJDocker {
        const fake = {
            getImage: () => ({ inspect: async () => ({}) }),
            createContainer: async () => ({
                start: async () => undefined,
                wait: async () => ({ StatusCode: 0 }),
                logs: async () => Buffer.concat(frames),
                remove: async () => undefined,
            }),
        }
        return new KJDocker(silentLogger, fake as never)
    }

    test('forged full lines on stderr cannot spoof the markers', async () => {
        // The green-path vector of the 3rd security pass: normal `.backup`
        // fails on a file whose NAME embeds newlines, sqlite3 prints the raw
        // path to stderr, and the forged lines would pass any line-anchored
        // regex — if stderr were parsed at all.
        const result = await helperDocker([
            frame(
                2,
                'Error: unable to open database "/v/evil\nKJ_PART=1:etagfalso\nKJ_BACKUP_SIZE=1\nx.db": unable to open database file\n'
            ),
            frame(2, 'tar: ./KJ_BACKUP_SIZE=2: file changed as we read it\n'),
            frame(1, 'KJ_TAR_WARN=1\nKJ_BACKUP_SIZE=773938408\n'),
        ]).backupVolume('kj-agent-4-home', 'https://r2/put')
        expect(result.size_bytes).toBe(773_938_408)
        // No parts: the single-PUT path must not trick the control into
        // sealing a multipart that does not exist.
        expect(result.parts).toBeUndefined()
    })

    test('markers split across frame boundaries still parse', async () => {
        // The daemon frames wherever it flushes; a cut in the middle of a
        // marker must be invisible after demuxing (the old byte-filter let
        // printable SIZE bytes of the headers leak INTO the text instead).
        const result = await helperDocker([
            frame(1, 'KJ_BACKUP_'),
            frame(1, 'SIZE=6666226321\nKJ_PART=1:abc\n'),
            frame(2, 'ruido del tar en medio\n'),
            frame(1, 'KJ_PART=2:def\n'),
        ]).backupVolume('kj-agent-10-home', 'https://r2/put')
        expect(result.size_bytes).toBe(6_666_226_321)
        expect(result.parts).toEqual([
            { part_number: 1, etag: 'abc' },
            { part_number: 2, etag: 'def' },
        ])
    })
})
