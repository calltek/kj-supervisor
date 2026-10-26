/**
 * Thin wrapper around dockerode tailored to what the supervisor needs.
 * Keeps the surface small (pull, run, inspect, list, remove) so the
 * rest of the code never imports dockerode directly — easier to mock
 * in tests and easier to swap implementation later.
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import Docker from 'dockerode'

import type { KJLogger } from '../../logger'
import {
    ISOLATION_LABEL,
    ISOLATION_STATE_MOUNT,
    type IsolationMode,
    agentHardening,
    isolationModeOf,
    ensureIsolationMount,
    isolationVolumeName,
    privilegedNetworkingExtras,
    withoutDockerSocket,
    withoutIsolationCaps,
} from './hardening'
import { agentHostAliases, isHostGatewayUnsupported, recreatedHostAliases } from './host-access'
import { buildSeedScript } from './seed-script'

/**
 * Our own container id, read from /proc — works under `--network host` where
 * os.hostname() is the HOST name, not the container id (incident 2026-06-24).
 * cgroup v1 puts `/docker/<id>` in /proc/self/cgroup; cgroup v2 puts the id in
 * the bind-mount paths of /proc/self/mountinfo (…/containers/<id>/hostname).
 * Returns the 64-hex id or null (e.g. running outside Docker in dev).
 */
function readOwnContainerId(): string | null {
    const re = /\b[0-9a-f]{64}\b/
    for (const path of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
        try {
            const m = fs.readFileSync(path, 'utf8').match(re)
            if (m) return m[0]
        } catch {
            /* not on Linux / no procfs — try the next, then give up */
        }
    }
    return null
}

/** Labels we attach to every container we spawn so we can reconcile later. */
export const KJ_LABEL = 'kj-agent'
export const KJ_LABEL_AGENT_ID = 'kj-agent-id'

export interface KJContainerRunOptions {
    image_tag: string
    name: string
    env: Record<string, string>
    cmd?: string[]
    labels: Record<string, string>
    resources: { memory_mb: number; cpu: number }
    /**
     * Named docker volume to mount at /home/agent for this container.
     * Persists the agent's home (claude transcripts under .claude/,
     * memories, skills) across stop+start. Created on demand if missing.
     */
    home_volume_name?: string
    /**
     * Privileged networking (KJ-156): add the `/dev/net/tun` device +
     * `CAP_NET_ADMIN` so the agent can bring up a VPN itself. Opt-in per agent;
     * everything else stays locked down (CapDrop ALL + no-new-privileges).
     */
    network_privileged?: boolean
}

export interface KJContainerSummary {
    container_id: string
    agent_id: number | null
}

/** Shape of each pull progress event Docker emits per layer. */
export interface PullProgressEvent {
    status: string
    id?: string
    progressDetail?: { current?: number; total?: number }
    progress?: string
}

/**
 * Shape of a Docker daemon event (the subset we care about). Docker's
 * stream emits a JSON line per event with many more fields; we type
 * only what the watcher reads.
 */
export interface DockerEvent {
    Type: string // 'container', 'image', 'network'...
    Action: string // 'start', 'die', 'stop', 'kill', 'pause', 'unpause', 'destroy'...
    Actor: {
        ID: string // container id
        Attributes?: Record<string, string> // labels + extras
    }
    time?: number
    timeNano?: number
}

/**
 * The shell the backup helper runs, as a pure string so it can be tested.
 *
 * It lives here and not inline because what it does is load-bearing and easy
 * to break by accident: which paths are skipped, and that SQLite databases are
 * copied with the mechanism that survives a concurrent writer.
 *
 * Two archive layouts. Without `withIso` the home volume is mounted at /v and
 * every entry is `./…` — the format every backup had until now. With it, the
 * home volume sits at /v/home and the isolation-state volume (each isolated
 * conversation's HOME, the uid registry) at /v/iso, and the entries are
 * `home/…` and `iso/…` with NO `./` prefix. That prefix is how the restore
 * tells them apart: an old archive can never start with `home/`, whatever the
 * agent named its files, so nothing it writes in its home can reach the
 * root-owned volume on restore.
 */
export function buildBackupScript(withIso = false): string {
    return [
        'set -e',
        // GNU tar además de BusyBox: hace falta para meter en UN solo archivo
        // dos orígenes distintos (`-C` dos veces). El de BusyBox aplica el
        // último `-C` a todos y se pierde el volumen — comprobado.
        // stdout only: if apk fails (a CDN hiccup), `set -e` kills the whole
        // helper, and with stderr swallowed the backup died with "exited 1:"
        // and not a word of why. Whatever apk has to say must reach the logs.
        withIso
            ? 'apk add --no-cache curl sqlite tar setpriv >/dev/null'
            : 'apk add --no-cache curl sqlite tar >/dev/null',
        '',
        '# Copias consistentes de las bases SQLite, en /tmp del ayudante.',
        '#',
        '# El volumen va montado en SOLO LECTURA, y eso NO se toca: que una',
        '# copia no pueda escribir en el disco del cliente vale más que la',
        '# comodidad de dejar el fichero al lado. Por eso las copias van al',
        '# overlay del ayudante, que además desaparece con el contenedor (sin',
        '# restos, sin llenar el volumen del cliente, sin carreras entre dos',
        '# copias simultáneas).',
        'STAGE=/tmp/kjdb',
        'umask 077',
        'mkdir -p "$STAGE"',
        ': > /tmp/kjdb.failed',
        // With /v/iso mounted next to the home, sqlite3 must not run as root:
        // with DAC_OVERRIDE, a directory in the home swapped for a symlink
        // into ../iso between find and sqlite3 hands it an isolated
        // conversation's database, and no check before the open closes that
        // race. As the agent's uid with no capabilities it reads only what the
        // agent can, and the kernel stops the symlink at iso's uids. It writes
        // to a staging dir of its own; root moves the copy into place.
        ...(withIso
            ? [
                  'export KJ_AS="setpriv --reuid=1000 --regid=1000 --clear-groups"',
                  'export KJ_W=/tmp/kjdb.w',
                  'mkdir -p "$KJ_W"',
                  'chown 1000:1000 "$KJ_W"',
              ]
            : ['export KJ_AS=""', 'export KJ_W=/tmp/kjdb']),
        '',
        '# Antes de escribir un solo byte: ¿cabe? El ayudante escribe en SU',
        '# overlay, que sale del disco del supervisor — el mismo que usan TODOS',
        '# los agentes del host. Llenarlo copiando a uno los tumba a todos, y',
        '# ese es un precio que ninguna copia vale. Como cota se usa el tamaño',
        '# del volumen en crudo (el .tgz siempre sale más pequeño) más las',
        '# copias en caliente; si no cabe, se falla AQUÍ y con nombre.',
        'NEED=$(du -sk /v 2>/dev/null | cut -f1)',
        "FREE=$(df -Pk /tmp | awk 'NR==2 {print $4}')",
        'if [ -n "$NEED" ] && [ -n "$FREE" ] && [ "$FREE" -lt "$NEED" ]; then',
        '  echo "sin espacio en el supervisor: hacen falta ~$NEED KB y quedan $FREE KB" >&2',
        '  exit 8',
        'fi',
        '',
        '# `-exec … +` en vez de recorrer la salida de find: un nombre con un',
        '# salto de línea rompe cualquier bucle que la parsee.',
        // Nothing under iso/ gets a hot copy. Every isolated conversation has
        // its own uid there, and this copy runs as root with DAC_OVERRIDE: a
        // conversation that swaps a directory for a symlink between find and
        // sqlite3 would get another one's database copied into its own tree.
        // Those databases travel in the tar alone, which follows no symlink —
        // possibly inconsistent, never someone else's.
        withIso
            ? 'find /v -path /v/iso -prune -o -type f \\( -name "*.sqlite3" -o -name "*.sqlite" -o -name "*.db" \\) \\'
            : 'find /v -type f \\( -name "*.sqlite3" -o -name "*.sqlite" -o -name "*.db" \\) \\',
        '     -not -path "*/node_modules/*" -not -path "*/.venv/*" \\',
        "     -exec sh -c '",
        '  for DB do',
        '    # Sólo lo que de VERDAD es SQLite: un .db que no lo sea haría',
        '    # fallar la copia entera por un fichero que no importa.',
        '    head -c 15 "$DB" | grep -q "SQLite format 3" || continue',
        '    REL=${DB#/v/}',
        '    SEQ=$(cat /tmp/kjdb.seq 2>/dev/null || echo 0); SEQ=$((SEQ+1))',
        '    echo "$SEQ" > /tmp/kjdb.seq',
        '    # `.backup` y no `VACUUM INTO`: es una orden del cliente, toma la',
        '    # ruta SIN comillas, y así no hay comillas SQL que choquen con las',
        '    # del `sh -c` que envuelve esto. Hace lo mismo — una copia',
        '    # consistente respetando el bloqueo de quien escribe.',
        '    #',
        '    # Y el destino es un CONTADOR, no la ruta: el nombre del fichero lo',
        '    # controla el agente, y el cliente de sqlite3 ejecuta su argumento',
        '    # como script entero.',
        '    # El mv entra en la MISMA condición que la copia: si la copia sale',
        '    # bien pero moverla a su sitio no, la original rota gana en el tar y',
        '    # queda un copia-N suelto en la raíz del archivo. Un fallo parcial',
        '    # que nadie ve es lo que este cambio viene a quitar.',
        '    #',
        // The fallback: a WAL database on the read-only mount. SQLite cannot
        // open one the normal way there (it needs to create the -shm to read),
        // so `.backup` dies with "unable to open database file" — Soki, night
        // of 2026-08-27, over an idle `.aws/cli/cache/session.db`. When its
        // -wal/-shm are NOT on disk the file is fully checkpointed and nobody
        // is mid-write, so `immutable=1` (the SQLite door for read-only
        // media) can take the copy. With sidecars present a consistent copy
        // is impossible from here and the honest outcome is still
        // kjdb.failed → exit 7.
        //
        // Three guards around it (security review, PR #25):
        // - In `file:` the name stops being an opaque path and becomes a URI,
        //   where `?`/`#`/`%` are metacharacters — and the file name is the
        //   agent's. A name carrying any of them never reaches the URI; it
        //   falls through to kjdb.failed, exactly where it landed before the
        //   fallback existed. Same for a name with a NEWLINE in it (which no
        //   URI can represent anyway): compared against itself through
        //   `tr -d "\n"` — command substitution also eats trailing newlines,
        //   so a name ending in one fails the comparison too, which is the
        //   point.
        // - `immutable=1` tells SQLite to skip locks, so a writer sneaking in
        //   between the sidecar check and the copy would corrupt it SILENTLY.
        //   The copy only counts if `PRAGMA integrity_check` says ok…
        // - …and the sidecars are STILL absent after it, which shrinks that
        //   window to nothing that matters: a writer that appeared mid-copy
        //   leaves a -wal behind, and that voids the copy.
        //
        // `-journal` sits in both checks alongside -wal/-shm: a hot rollback
        // journal is the OTHER case where the normal `.backup` fails on a
        // read-only mount (SQLITE_READONLY_ROLLBACK), and `immutable=1` would
        // swallow it whole — integrity_check comes back ok because what a
        // half-rolled transaction breaks is atomicity, not page structure.
        '    if { $KJ_AS sqlite3 "$DB" ".backup $KJ_W/copia-$SEQ" ||',
        '         { [ ! -f "$DB-wal" ] && [ ! -f "$DB-shm" ] && [ ! -f "$DB-journal" ] &&',
        '           case "$DB" in (*"?"*|*"#"*|*"%"*) false ;; (*) true ;; esac &&',
        '           [ "$DB" = "$(printf %s "$DB" | tr -d "\\n")" ] &&',
        '           $KJ_AS sqlite3 "file:$DB?immutable=1" ".backup $KJ_W/copia-$SEQ" &&',
        '           [ "$($KJ_AS sqlite3 "$KJ_W/copia-$SEQ" "PRAGMA integrity_check;")" = "ok" ] &&',
        '           [ ! -f "$DB-wal" ] && [ ! -f "$DB-shm" ] && [ ! -f "$DB-journal" ]; }; } &&',
        '       mkdir -p "/tmp/kjdb/$(dirname "$REL")" &&',
        // Back to root: written as the agent, root (no FOWNER) couldn't give
        // it the original's mode further down.
        '       mv "$KJ_W/copia-$SEQ" "/tmp/kjdb/$REL" &&',
        '       chown 0:0 "/tmp/kjdb/$REL"; then',
        '      :',
        // Running as the agent, a database it can't read (one the image keeps
        // root-only) can't get a hot copy; it travels in the tar like iso/.
        // Faking this only skips the agent's own database's hot copy.
        '    elif [ -n "$KJ_AS" ] && ! $KJ_AS test -r "$DB"; then',
        '      echo "sin copia en caliente, el agente no puede leerla: $DB" >&2',
        '      rm -f "$KJ_W/copia-$SEQ"',
        '      continue',
        '    else',
        '      echo "$DB" >> /tmp/kjdb.failed',
        '      continue',
        '    fi',
        '    # El -wal/-shm de la ORIGINAL pertenece a otro instante que el de',
        '    # nuestra copia. Si viaja tal cual, al restaurar SQLite intentaría',
        '    # aplicarlo sobre una base que ya lo lleva dentro. Se sustituyen por',
        '    # ficheros vacíos (que para SQLite significa "nada que reproducir"),',
        '    # y sólo si existían: crear un -wal donde no lo había empujaría a',
        '    # modo WAL a una base que no lo usa.',
        // `-journal` for the same reason: a hot rollback journal from another
        // instant would be REPLAYED on first open of the restored copy,
        // planting the corruption at restore time. Zero-length means
        // "nothing to roll back", and (blanked only if it existed) a
        // PERSIST-mode database keeps the journal file it expects.
        '    for SUF in -wal -shm -journal; do',
        // `if`, NOT `[ -f ] && …`: when the last database processed has no
        // sidecar, that AND-list leaves status 1 as the exit code of the loop
        // — and thus of the inner shell. BusyBox find propagates it, `set -e`
        // aborts, and the backup dies as a mute "exited 1:" (NOVA, night of
        // 2026-08-27). An `if` that takes no branch exits 0.
        '      if [ -f "$DB$SUF" ]; then : > "/tmp/kjdb/$REL$SUF"; fi',
        '    done',
        '  done',
        // If find itself fails (unreadable dir, a crash in the inner shell),
        // say so: bare `set -e` here used to kill the helper with no output
        // at all, which is the worst kind of red.
        '\' _ {} + || { echo "el recorrido de bases sqlite falló" >&2; exit 9; }',
        '',
        '# Y si alguna falló, la copia FALLA. Un backup que se sube en verde',
        '# sabiendo que una base puede estar rota es peor que no tenerlo: el',
        '# fallo sólo se descubre el día que hay que restaurar.',
        'if [ -s /tmp/kjdb.failed ]; then',
        '  echo "no se pudo copiar en caliente:" >&2; cat /tmp/kjdb.failed >&2',
        '  exit 7',
        'fi',
        '',
        '# Las copias y sus carpetas nacen de root y 0700, y al extraer pisan',
        '# a las originales: una carpeta con una base dentro volvía de root, y',
        '# su dueño ya no podía entrar en ella. Se les da el dueño y el modo del',
        '# original. chmod antes que chown: luego ya no son de root.',
        '#',
        '# Si el original ya no es la ruta que se copió (un componente cambiado',
        '# por un enlace mientras tanto), la copia falla: el modo y el dueño',
        '# saldrían de otro sitio.',
        'cd /tmp/kjdb',
        "find . -exec sh -c '",
        '  for P do',
        '    Q="/v/${P#./}"; if [ "$P" = . ]; then Q=/v; fi',
        '    [ "$(realpath "$Q")" = "$Q" ] || { echo "ruta cambiada durante la copia: $Q" >&2; exit 1; }',
        '    chmod "$(stat -c %a "$Q")" "$P" || exit 1',
        '    chown "$(stat -c %u:%g "$Q")" "$P" || exit 1',
        '  done',
        '\' _ {} + || { echo "no se pudo copiar el dueño de las bases" >&2; exit 10; }',
        'cd /',
        '',
        '# Las copias van DESPUÉS del volumen a propósito: al extraer, la última',
        '# entrada de una ruta repetida gana, así que una restauración se queda',
        '# con la versión consistente sin que nadie tenga que elegir.',
        '#',
        // GNU tar exit 1 means "a file changed/vanished while I read it" —
        // the normal weather of taring a volume a RUNNING agent keeps writing
        // to, and inherent to hot backups (the databases that must be
        // consistent already travel as the /tmp/kjdb copies). Under `set -e`
        // that warning was a lost backup every time the dice rolled badly.
        // Exit 2+ (truncated archive, I/O error) is a real failure and stays
        // fatal.
        ...(withIso
            ? [
                  // Both tops exist even with no database copied, so the
                  // member list never names a missing path (tar exit 2). Their
                  // own entries are stripped on restore, metadata and all.
                  'mkdir -p /tmp/kjdb/home /tmp/kjdb/iso',
                  // Numeric: the isolated conversations' files belong to uids
                  // that exist only inside the agent's image.
                  'tar -czf /tmp/b.tgz --numeric-owner -C /v home iso -C /tmp/kjdb home iso || {',
              ]
            : ['tar -czf /tmp/b.tgz -C /v . -C /tmp/kjdb . || {']),
        '  RC=$?',
        '  if [ "$RC" -ge 2 ]; then exit "$RC"; fi',
        '  echo "aviso: ficheros cambiando durante el tar (agente en marcha)" >&2',
        // The marker survives where the stderr line does not: on success
        // nobody reads the helper logs, and the difference between a clean
        // copy and a hot one with files moving underneath deserves to
        // outlive the night — backupVolume() picks it up and logs a warn.
        '  echo "KJ_TAR_WARN=1"',
        '}',
        '',
        '# Las copias en caliente ya viajan dentro del tar.',
        'find /v -name "*.kjbackup" -delete 2>/dev/null || true',
        'SZ=$(stat -c %s /tmp/b.tgz)',
        'echo "KJ_BACKUP_SIZE=$SZ"',
        '',
        '# Fits in one PUT (or the control gave us no parts): original path.',
        'if [ -z "$KJ_PART_URLS" ] || [ "$SZ" -le "$KJ_SINGLE_LIMIT" ]; then',
        '  curl -sS --fail-with-body -X PUT -H "Content-Type: application/octet-stream" \\',
        '       --upload-file /tmp/b.tgz "$KJ_UPLOAD_URL"',
        '  exit 0',
        'fi',
        '',
        '# Too big for one PUT: cut it into chunks and send them one by one.',
        'PARTS=$(printf "%s\\n" "$KJ_PART_URLS" | wc -l)',
        'NEEDED=$(( (SZ + KJ_PART_SIZE - 1) / KJ_PART_SIZE ))',
        'if [ "$NEEDED" -gt "$PARTS" ]; then',
        '  echo "backup too large: needs $NEEDED parts, only $PARTS signed" >&2',
        '  exit 3',
        'fi',
        'N=1',
        'while [ "$N" -le "$NEEDED" ]; do',
        '  URL=$(printf "%s\\n" "$KJ_PART_URLS" | sed -n "${N}p")',
        '  OFFSET=$(( (N - 1) * KJ_PART_SIZE ))',
        '  dd if=/tmp/b.tgz of=/tmp/part.bin bs=1048576 \\',
        '     skip=$(( OFFSET / 1048576 )) count=$(( KJ_PART_SIZE / 1048576 )) 2>/dev/null',
        '  # -D dumps the response headers; the ETag in there is what the',
        '  # control needs to seal the object.',
        '  curl -sS --fail-with-body -X PUT -D /tmp/h.txt --upload-file /tmp/part.bin "$URL"',
        '  ETAG=$(sed -n "s/^[Ee][Tt][Aa][Gg]: *//p" /tmp/h.txt | tr -d "\\r\\"")',
        '  if [ -z "$ETAG" ]; then echo "part $N uploaded without an ETag" >&2; exit 4; fi',
        '  echo "KJ_PART=$N:$ETAG"',
        '  rm -f /tmp/part.bin /tmp/h.txt',
        '  N=$(( N + 1 ))',
        'done',
    ].join('\n')
}

/**
 * The model credential goes in the container's Config.Env, and `docker exec`
 * starts from there — not from PID 1, which kj-agent-base cleans
 * (kj-agent-base#108, #111). A SCRIPT cron's command is written by the agent
 * (`cronjob_create`), so `env` in one would hand the key back in the cron's
 * thread. Every exec starts with them unset — except one this exec injects on
 * purpose (KJ-38: a cron credential that happens to have that name).
 */
export const MODEL_CREDENTIAL_VARS = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
] as const

export function execCmd(command: string, env?: Record<string, string>): string[] {
    const unset = MODEL_CREDENTIAL_VARS.filter((name) => !(env && name in env)).flatMap((name) => [
        '-u',
        name,
    ])
    return ['env', ...unset, '/bin/sh', '-c', command]
}

/** uid:gid of the agent user (`bun`) inside the agent images. */
export const EXEC_USER = '1000:1000'

export class KJDocker {
    private readonly docker: Docker
    private readonly logger: KJLogger

    constructor(logger: KJLogger, docker?: Docker) {
        this.logger = logger.child({ component: 'docker' })
        this.docker = docker ?? new Docker()
    }

    /**
     * The Docker daemon's own ID — a stable fingerprint of THIS machine.
     *
     * The control plane uses it to enforce one machine = one server = one
     * organization: installing a second supervisor on a box used to evict the
     * first one in silence. The hostname can't do that job (it repeats across
     * boxes and changes on a whim) and neither can the observed IP (dynamic on
     * a NAS, shared behind NAT). The daemon ID is stable per Docker install and
     * readable on Linux, Synology DSM and macOS alike, unlike /etc/machine-id.
     *
     * Returns undefined when the daemon won't say: the control simply can't
     * enforce uniqueness for this host, which is where we already were.
     */
    async machineId(): Promise<string | undefined> {
        try {
            const info = (await this.docker.info()) as { ID?: unknown }
            return typeof info.ID === 'string' && info.ID.length > 0 ? info.ID : undefined
        } catch {
            return undefined
        }
    }

    /**
     * Returns true when the daemon already has a local image with the
     * given tag. Used by the spawn handler to skip the pull entirely
     * when the image is cached — important for development (where the
     * tag may not exist in the remote registry at all) and a nice-to-
     * have in production (saves the registry round-trip on every
     * spawn after the first).
     */
    /** `docker image inspect` — by id or by tag. */
    async inspectImage(image: string): Promise<Docker.ImageInspectInfo> {
        return this.docker.getImage(image).inspect()
    }

    /**
     * Whether an image asks to run each conversation as its own uid
     * (ISOLATION_LABEL, kj-agent-base#107). The image is local by the time a
     * container is created from it; a failed inspect means "no" — the container
     * is then created as hardened as every other, never more.
     */
    async imageIsolatesByUser(image_tag: string): Promise<boolean> {
        return (await this.imageIsolationMode(image_tag)) === 'root'
    }

    /**
     * How an image isolates its conversations (ISOLATION_LABEL): not at all,
     * with a root launcher (kj-agent-base#107), or without root, through this
     * supervisor's exec (kj-agent-base docs/aislamiento-sin-root.md). A failed
     * inspect means "none" — never more than the hardened default.
     */
    async imageIsolationMode(image_tag: string): Promise<IsolationMode> {
        try {
            const info = await this.inspectImage(image_tag)
            return isolationModeOf(info.Config?.Labels?.[ISOLATION_LABEL])
        } catch (err) {
            this.logger.warn(
                { image_tag, err: err instanceof Error ? err.message : err },
                'could not inspect image for the isolation label — treating as not isolating'
            )
            return 'none'
        }
    }

    /**
     * The isolation-state volume of an image without root: `conv` root `1733`
     * (each conversation creates its own HOME there), `bin` of uid 998. A new
     * volume gets this from the image anyway; one that already exists — from
     * the root launcher, or an older image — is brought to it here, before the
     * container mounts it.
     */
    async prepareExecIsolationVolume(volume_name: string): Promise<void> {
        const { code } = await this.runVolumeHelper({
            volume_name,
            script: [
                'set -e',
                'mkdir -p /v/conv /v/bin',
                'chown 0:0 /v /v/conv',
                'chmod 0711 /v',
                'chmod 1733 /v/conv',
                'chown 998:998 /v/bin',
                'chmod 0755 /v/bin',
            ].join('\n'),
        })
        if (code !== 0) throw new Error(`isolation volume helper exited ${code}`)
    }

    /**
     * The uid registry a root launcher kept on the isolation volume
     * (`registry/uids.json`), read-only, or null. Taken over once so the
     * conversations that were already isolated keep their uids, and so the
     * HOMEs they own.
     */
    async readLegacyUidRegistry(volume_name: string): Promise<string | null> {
        const { code, stdout } = await this.runVolumeHelper({
            volume_name,
            readonly: true,
            script: 'cat /v/registry/uids.json 2>/dev/null || true',
        })
        if (code !== 0) return null
        return stdout.trim() || null
    }

    /** The isolation-state volume mounted in a container, if any. */
    async isolationVolumeOf(container_id: string): Promise<string | null> {
        const info = await this.inspect(container_id)
        const m = (info.Mounts ?? []).find((x) => x.Destination === ISOLATION_STATE_MOUNT)
        return m?.Name ?? null
    }

    /** How the image of a running container isolates (its labels carry the image's). */
    async containerIsolationMode(container_id: string): Promise<IsolationMode> {
        const info = await this.inspect(container_id)
        return isolationModeOf(info.Config?.Labels?.[ISOLATION_LABEL])
    }

    /**
     * Start a process in a container as `user`, detached: it outlives this
     * call (and a restart of the supervisor). Only for the isolation shim —
     * the command is fixed by the caller, never taken from the agent.
     */
    async execDetached(opts: {
        container_id: string
        user: string
        cmd: string[]
        env: string[]
    }): Promise<void> {
        const exec = await this.docker.getContainer(opts.container_id).exec({
            Cmd: opts.cmd,
            Env: opts.env,
            User: opts.user,
            WorkingDir: '/',
            AttachStdin: false,
            AttachStdout: false,
            AttachStderr: false,
            Tty: false,
        })
        await exec.start({ Detach: true, Tty: false })
    }

    async imageExistsLocally(image_tag: string): Promise<boolean> {
        try {
            await this.docker.getImage(image_tag).inspect()
            return true
        } catch (err) {
            // dockerode throws on 404 with `statusCode: 404`. Any
            // other error (daemon down, permissions) we re-treat as
            // "not local" — the caller will then attempt a pull,
            // which surfaces the same underlying problem with better
            // error text.
            const status = (err as { statusCode?: number }).statusCode
            if (status === 404) return false
            return false
        }
    }

    /**
     * Pull an image from the registry. Resolves when the daemon has the
     * image; rejects on pull failure (network, auth, missing tag).
     *
     * `onProgress` is invoked on every layer event (downloading,
     * extracting...) so the caller can surface granular progress to
     * the control. The callback must not throw.
     *
     * `auth` is forwarded to the docker daemon as the registry
     * credentials for THIS pull. Use it for private images. Never log
     * its contents — `dockerode` already does the right thing here.
     */
    async pullImage(
        image_tag: string,
        onProgress?: (event: PullProgressEvent) => void,
        auth?: { username: string; password: string; serveraddress?: string }
    ): Promise<void> {
        this.logger.info({ image_tag, authenticated: Boolean(auth) }, 'pulling image')
        // dockerode forwards `authconfig` to the daemon as the X-Registry-Auth
        // header, which is what `docker login + docker pull` does under the hood.
        const pullOptions: Record<string, unknown> = {}
        if (auth) {
            pullOptions.authconfig = {
                username: auth.username,
                password: auth.password,
                serveraddress: auth.serveraddress,
            }
        }
        const stream = await this.docker.pull(image_tag, pullOptions)
        await new Promise<void>((resolve, reject) => {
            this.docker.modem.followProgress(
                stream,
                (err) => (err ? reject(err) : resolve()),
                (event: PullProgressEvent) => {
                    if (onProgress) onProgress(event)
                }
            )
        })
        this.logger.info({ image_tag }, 'image pulled')
    }

    /**
     * Create + start a container. Returns its id. The caller is
     * responsible for any post-start verification (inspect, status push).
     *
     * The container is created with stdin open and stdout/stderr ready
     * to attach: agents talk stream-json over stdio, so the supervisor
     * uses `attachContainer` to read the JSON output and write user
     * messages. `Tty:false` keeps stdout/stderr multiplexed; the
     * caller passes the duplex through `docker.modem.demuxStream`.
     */
    async runContainer(opts: KJContainerRunOptions): Promise<string> {
        const envArray = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
        const mode = await this.imageIsolationMode(opts.image_tag)
        // Root launcher: its capabilities. Without root: none, only the volume.
        const isolation = mode === 'root'
        if (mode === 'exec' && opts.home_volume_name)
            await this.prepareExecIsolationVolume(isolationVolumeName(opts.home_volume_name))
        if (isolation)
            this.logger.info(
                { image_tag: opts.image_tag },
                'image isolates conversations by uid — adding the isolation capabilities'
            )

        // Persistent /home/agent volume. Docker creates the named volume
        // on first use if it doesn't exist, so we don't need a separate
        // create step. The mount survives stop+start; only `agent:delete`
        // removes it (see `removeHomeVolume`).
        const mounts = opts.home_volume_name
            ? [
                  {
                      Type: 'volume' as const,
                      Source: opts.home_volume_name,
                      Target: '/home/agent',
                  },
                  // An isolating image keeps its root-owned state (uid registry,
                  // quarantine, each conversation's isolated HOME) on a SEPARATE
                  // volume, never on /home/agent — which the supervisor seeds and
                  // wipes per spawn (kj-agent-base#107 design B). Created on first
                  // use, removed with the agent (handleDelete).
                  ...(mode !== 'none'
                      ? [
                            {
                                Type: 'volume' as const,
                                Source: isolationVolumeName(opts.home_volume_name),
                                Target: ISOLATION_STATE_MOUNT,
                            },
                        ]
                      : []),
              ]
            : undefined

        const container = await this.createAgentContainer({
            Image: opts.image_tag,
            name: opts.name,
            Env: envArray,
            Cmd: opts.cmd,
            Labels: opts.labels,
            Tty: false,
            OpenStdin: true,
            StdinOnce: false,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                // Resource limits
                Memory: opts.resources.memory_mb * 1024 * 1024,
                NanoCpus: Math.round(opts.resources.cpu * 1_000_000_000),
                // Security posture: drop everything, no privilege escalation,
                // plus this agent's networking extras if it's entitled to them
                // (KJ-156). Built by `agentHardening` so the recreate path gets
                // the identical posture — see hardening.ts for why that matters.
                ...agentHardening({
                    ...(opts.network_privileged ? privilegedNetworkingExtras() : {}),
                    isolation,
                }),
                // Un nombre para la máquina donde corre, que es donde puede
                // estar su modelo (un Ollama en el `11434` del host). Ver
                // host-access.ts: no amplía lo que alcanza, lo nombra.
                ExtraHosts: agentHostAliases(),
                // Restart so the container survives docker daemon restarts but
                // not its own crashes (the supervisor decides whether to relaunch).
                RestartPolicy: { Name: 'unless-stopped' },
                Mounts: mounts,
            },
        })

        await container.start()
        this.logger.info(
            { container_id: container.id, name: opts.name, image_tag: opts.image_tag },
            'container started'
        )
        return container.id
    }

    /**
     * Attach to a running container's stdio. Returns the raw duplex
     * stream from the docker daemon; the caller is responsible for
     * demultiplexing stdout/stderr (the streams are interleaved with
     * an 8-byte frame header when `Tty:false`) using
     * `demuxAttachStream` below.
     */
    /**
     * Attach to a container's stdio over the docker UNIX socket.
     *
     * We bypass dockerode here because Bun's `http.request` does not
     * emit `'upgrade'` events reliably (the same call works under Node
     * but hangs under Bun), and dockerode's attach relies on that
     * event. Going straight to the socket with `net.connect` works on
     * both runtimes and gives us the same multiplexed duplex (8-byte
     * frame header for stdout/stderr) that `demuxAttachStream` already
     * knows how to unpack.
     */
    async attachContainer(container_id: string): Promise<NodeJS.ReadWriteStream> {
        const socketPath = '/var/run/docker.sock'
        const path = `/containers/${container_id}/attach?stream=1&stdin=1&stdout=1&stderr=1`
        const request =
            `POST ${path} HTTP/1.1\r\n` +
            `Host: localhost\r\n` +
            `Connection: Upgrade\r\n` +
            `Upgrade: tcp\r\n` +
            `Content-Type: application/vnd.docker.raw-stream\r\n` +
            `Content-Length: 0\r\n` +
            `\r\n`

        return new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
            const sock = net.connect(socketPath)
            let header_buffer = ''
            let upgraded = false

            const timer = setTimeout(() => {
                if (upgraded) return
                sock.destroy(new Error('docker attach timed out after 10s'))
            }, 10_000)

            sock.once('error', (err) => {
                clearTimeout(timer)
                if (!upgraded) reject(err)
            })

            const onHeader = (chunk: Buffer): void => {
                header_buffer += chunk.toString('utf8')
                const end = header_buffer.indexOf('\r\n\r\n')
                if (end < 0) return // need more bytes
                const head = header_buffer.slice(0, end)
                const remainder = Buffer.from(
                    header_buffer.slice(end + 4),
                    'binary' as BufferEncoding
                )

                const status_line = head.split('\r\n')[0] ?? ''
                if (!status_line.includes('101')) {
                    clearTimeout(timer)
                    sock.destroy()
                    reject(new Error(`docker attach refused: ${status_line || '<no status>'}`))
                    return
                }

                upgraded = true
                clearTimeout(timer)
                sock.off('data', onHeader)
                // Any payload that arrived in the same TCP segment as
                // the HTTP headers must be replayed into the duplex.
                if (remainder.length > 0) sock.unshift(remainder)
                resolve(sock)
            }

            sock.on('data', onHeader)
            sock.write(request)
        })
    }

    /**
     * Attach to a container's STDIN only, returning the writable socket.
     * Used by `seedVolumeFiles` to feed a large `sh -s` script over the
     * stream instead of through Cmd (which would hit ARG_MAX). Same raw
     * socket-upgrade dance as `attachContainer`, but stdin-only — we
     * don't read the helper's output here (the caller pulls logs via
     * `container.logs()` after it exits).
     */
    async attachContainerStdin(container_id: string): Promise<NodeJS.WritableStream> {
        const socketPath = '/var/run/docker.sock'
        const path = `/containers/${container_id}/attach?stream=1&stdin=1`
        const request =
            `POST ${path} HTTP/1.1\r\n` +
            `Host: localhost\r\n` +
            `Connection: Upgrade\r\n` +
            `Upgrade: tcp\r\n` +
            `Content-Type: application/vnd.docker.raw-stream\r\n` +
            `Content-Length: 0\r\n` +
            `\r\n`

        return new Promise<NodeJS.WritableStream>((resolve, reject) => {
            const sock = net.connect(socketPath)
            let header_buffer = ''
            let upgraded = false

            const timer = setTimeout(() => {
                if (upgraded) return
                sock.destroy(new Error('docker stdin attach timed out after 10s'))
            }, 10_000)

            sock.once('error', (err) => {
                clearTimeout(timer)
                if (!upgraded) reject(err)
            })

            const onHeader = (chunk: Buffer): void => {
                header_buffer += chunk.toString('utf8')
                const end = header_buffer.indexOf('\r\n\r\n')
                if (end < 0) return
                const status_line = header_buffer.slice(0, end).split('\r\n')[0] ?? ''
                if (!status_line.includes('101')) {
                    clearTimeout(timer)
                    sock.destroy()
                    reject(
                        new Error(`docker stdin attach refused: ${status_line || '<no status>'}`)
                    )
                    return
                }
                upgraded = true
                clearTimeout(timer)
                sock.off('data', onHeader)
                resolve(sock)
            }

            sock.on('data', onHeader)
            sock.write(request)
        })
    }

    /**
     * Demultiplex a docker attach stream into stdout/stderr writable
     * sinks. When the container runs without TTY, docker frames every
     * payload with an 8-byte header that says which stream the bytes
     * came from; `dockerode`'s modem knows how to unpack it.
     */
    demuxAttachStream(
        stream: NodeJS.ReadableStream,
        stdout: NodeJS.WritableStream,
        stderr: NodeJS.WritableStream
    ): void {
        this.docker.modem.demuxStream(stream, stdout, stderr)
    }

    /** Get a container's basic state (running, exitCode, etc.). */
    async inspect(container_id: string): Promise<Docker.ContainerInspectInfo> {
        return this.docker.getContainer(container_id).inspect()
    }

    /**
     * Run a one-shot command inside a container (`docker exec`) and return its
     * merged stdout/stderr + exit code. Runs as `/bin/sh -c "<command>"` so a
     * full shell line works. Captures up to `maxOutputBytes` and truncates the
     * rest. Kills the exec and resolves `timedOut: true` past `timeout_ms`.
     */
    async exec(opts: {
        container_id: string
        command: string
        timeout_ms: number
        maxOutputBytes?: number
        // Extra env vars for THIS exec only (KJ-38: a SCRIPT cron's injected
        // credentials). Merged on top of the container env; never persisted.
        env?: Record<string, string>
    }): Promise<{ exit_code: number; output: string; truncated: boolean; timedOut: boolean }> {
        const maxBytes = opts.maxOutputBytes ?? 64 * 1024
        const container = this.docker.getContainer(opts.container_id)
        const exec = await container.exec({
            Cmd: execCmd(opts.command, opts.env),
            AttachStdout: true,
            AttachStderr: true,
            Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
            // Always the agent user, never the image's Config.User: the
            // `-isolation` image ends in `USER root` (its launcher must drop to
            // each conversation's uid), and a root exec with the isolation caps
            // reads every isolated conversation's HOME and transcript. In the
            // normal image the user is already bun, so this changes nothing.
            User: EXEC_USER,
            // Tty:true merges stdout+stderr into a single RAW stream (no 8-byte
            // multiplex frames), so we read bytes directly — no demux, and no
            // "(HTTP code 101) unexpected" from mishandling the hijacked socket.
            Tty: true,
        })
        const stream = (await exec.start({ Tty: true })) as NodeJS.ReadableStream

        return await new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            let size = 0
            let truncated = false
            let settled = false

            const collect = (): string => Buffer.concat(chunks).toString('utf8')

            const timer = setTimeout(() => {
                if (settled) return
                settled = true
                ;(stream as unknown as { destroy?: () => void }).destroy?.()
                resolve({ exit_code: -1, output: collect(), truncated, timedOut: true })
            }, opts.timeout_ms)

            stream.on('data', (chunk: Buffer) => {
                if (size >= maxBytes) {
                    truncated = true
                    return
                }
                const room = maxBytes - size
                chunks.push(chunk.subarray(0, room))
                if (chunk.length > room) truncated = true
                size += Math.min(chunk.length, room)
            })
            stream.on('end', () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                exec.inspect()
                    .then((info) =>
                        resolve({
                            exit_code: info.ExitCode ?? 0,
                            output: collect(),
                            truncated,
                            timedOut: false,
                        })
                    )
                    .catch(reject)
            })
            stream.on('error', (err: Error) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                reject(err)
            })
        })
    }

    /**
     * Re-create a container preserving its mounts, env, command,
     * labels, and network mode, but pointing at a different image
     * tag. Used for the supervisor's own blue/green self-upgrade.
     *
     * The new container starts running immediately. The caller is
     * responsible for the old one's shutdown.
     */
    async cloneContainerWithNewImage(opts: {
        source_container: string
        new_image_tag: string
        new_name: string
    }): Promise<string> {
        this.logger.info(
            {
                source: opts.source_container,
                image: opts.new_image_tag,
                name: opts.new_name,
            },
            'cloning container with new image'
        )

        const source = await this.docker.getContainer(opts.source_container).inspect()

        // Tell the clone its OWN container name so it can complete the blue/green
        // swap reliably. We can't depend on os.hostname() inside the clone: under
        // `--network host` (the whole Linux fleet) the container hostname is the
        // HOST's name, not the container id, so getContainer(os.hostname()) 404s
        // and the clone wrongly concludes it isn't a clone → never swaps → two
        // supervisors survive (incident 2026-06-24). Strip any stale value
        // inherited from the source (which may itself have been a clone).
        //
        // The build identity (KJ_BUILD_REVISION / KJ_BUILT_AT) is baked into the
        // IMAGE as ENV, but inspect() returns it as part of the source's Env, and
        // an explicit Env on the clone overrides the new image's. Left in, a
        // supervisor that just upgraded would keep reporting its old revision.
        const env = (source.Config.Env ?? []).filter(
            (e) =>
                !e.startsWith('KJ_OWN_CONTAINER=') &&
                !e.startsWith('KJ_BUILD_REVISION=') &&
                !e.startsWith('KJ_BUILT_AT=')
        )
        env.push(`KJ_OWN_CONTAINER=${opts.new_name}`)

        const created = await this.docker.createContainer({
            Image: opts.new_image_tag,
            name: opts.new_name,
            Env: env,
            Cmd: source.Config.Cmd ?? undefined,
            Entrypoint: source.Config.Entrypoint ?? undefined,
            Labels: source.Config.Labels,
            HostConfig: {
                Binds: source.HostConfig.Binds,
                Mounts: source.HostConfig.Mounts,
                RestartPolicy: source.HostConfig.RestartPolicy,
                NetworkMode: source.HostConfig.NetworkMode,
                GroupAdd: source.HostConfig.GroupAdd,
                // No ExtraHosts: this is the supervisor, not an agent — it runs
                // with `--network host` and the Docker socket, and the host
                // alias is an agent concern (host-access.ts, #34).
                // Preserve the source's resource limits (KUJI-42) — don't
                // silently drop them on the blue/green clone.
                Memory: source.HostConfig.Memory,
                NanoCpus: source.HostConfig.NanoCpus,
            },
        })

        await created.start()
        this.logger.info({ new_container_id: created.id }, 'clone started')
        return created.id
    }

    /**
     * Recreate a container under the SAME name, reusing the source's
     * env / labels / mounts / network but with whatever image the
     * caller passes. The previous container is stopped + removed first
     * (so the name is free for the new one). Used by the image-update
     * handler to "swap in" a freshly-pulled image without leaking the
     * env vars set by the original spawn payload.
     *
     * Unlike `cloneContainerWithNewImage`, this keeps the container
     * name stable, which matters for callers that look up by name.
     */
    async recreateContainerWithImage(opts: {
        source_container: string
        new_image_tag: string
        keep_name: string
        force_stop?: boolean
        // KUJI-42: re-apply the container limits the control sized. Without
        // this the recreate dropped Memory/NanoCpus and left the container
        // unbounded → a runaway tool (Playwright/Chromium) could OOM the host.
        // Falls back to whatever the source container had if absent.
        resources?: { memory_mb: number; cpu: number }
    }): Promise<string> {
        this.logger.info(
            {
                source: opts.source_container,
                image: opts.new_image_tag,
                name: opts.keep_name,
            },
            'recreating container with image'
        )

        const source = await this.docker.getContainer(opts.source_container).inspect()
        const config = source.Config
        const host = source.HostConfig

        // Carry over the runtime env (KJ_*, HOME, oauth, model, MCP, …) but DROP
        // PATH: it is provided by the IMAGE, never by spawn, so on an image swap
        // we want the NEW image's PATH, not the old one frozen in the source
        // container's Config.Env. Without this, an image that adds dirs to PATH
        // (e.g. ~/.local/bin for agent-installed tools, KJ-1) would never reach
        // a recreated container — the stale PATH shadows the new one. New image
        // ENV PATH wins because docker merges it when no PATH is provided here.
        const env = (config.Env ?? []).filter((e) => !e.startsWith('PATH='))

        // The new image may start (or stop) isolating conversations by uid;
        // read it from the image we are moving TO, not the one we are leaving.
        const mode = await this.imageIsolationMode(opts.new_image_tag)
        const isolation = mode === 'root'
        if (mode === 'exec') {
            const home = (host.Mounts ?? []).find((m) => m.Target === '/home/agent')
            if (home?.Source) await this.prepareExecIsolationVolume(isolationVolumeName(home.Source))
        }

        // Only the host alias crosses over; anything else in the source's
        // ExtraHosts was put there by hand and is dropped, with a trace (#34).
        const extraHosts = recreatedHostAliases(host.ExtraHosts)
        for (const entry of extraHosts.dropped)
            this.logger.warn(
                { container: opts.source_container, entry },
                'dropping an ExtraHosts entry the source container carried — not set by Kujira'
            )

        // Stop + remove old first; the name has to be free before we
        // can reuse it. Force is on by default — the operator already
        // accepted the downtime by clicking the button.
        await this.stopContainer(opts.source_container, { force: opts.force_stop ?? true })
        await this.removeContainer(opts.source_container)

        const sanitized = withoutDockerSocket(host)

        const created = await this.createAgentContainer({
            Image: opts.new_image_tag,
            name: opts.keep_name,
            Env: env,
            Cmd: config.Cmd ?? undefined,
            Entrypoint: config.Entrypoint ?? undefined,
            Labels: config.Labels,
            // Mirror what runContainer sets when spawning fresh agents:
            // the wrapper reads operator messages from process.stdin
            // and writes claude's stream-json on stdout, so the new
            // container MUST have stdin open + stdio attachable.
            // Dropped silently before, which left the wrapper polling
            // a stdin that never produced lines — heartbeats fine,
            // input dead.
            Tty: false,
            OpenStdin: true,
            StdinOnce: false,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                // Los montajes se copian del contenedor de origen, así que el
                // socket de Docker se colaría si alguien lo hubiera puesto ahí
                // a mano: no es un montaje, es la máquina entera (#12).
                ...sanitized,
                // Un cambio de imagen puede EMPEZAR a aislar: la fuente no
                // trae el volumen de estado, así que se añade (derivado del de
                // /home/agent que ya monta). Si deja de aislar, se queda un
                // montaje sin usar en vez de huérfanar sus datos (#107).
                Mounts: ensureIsolationMount(sanitized.Mounts, mode !== 'none'),
                RestartPolicy: host.RestartPolicy,
                NetworkMode: host.NetworkMode,
                GroupAdd: host.GroupAdd,
                // Recrear por imagen no puede dejar sin host a un agente que
                // corre contra un modelo local; y sólo pasa el alias (#34).
                ExtraHosts: extraHosts.hosts,
                // Re-apply the resource limits (KUJI-42). The control's value
                // wins; otherwise preserve what the source had (never silently
                // leave it unbounded again).
                Memory: opts.resources ? opts.resources.memory_mb * 1024 * 1024 : host.Memory,
                NanoCpus: opts.resources
                    ? Math.round(opts.resources.cpu * 1_000_000_000)
                    : host.NanoCpus,
                // The SAME posture a fresh spawn gets — same builder, so the two
                // can't drift apart again (they did once: a recreated agent came
                // back with Docker's ~14 default caps and no `no-new-privileges`).
                // The extras come from the SOURCE container rather than from the
                // control's intent: it is the source of truth for this agent's
                // networking, so a VPN agent keeps /dev/net/tun + NET_ADMIN
                // across an image update instead of losing them silently.
                // Strip any isolation caps the SOURCE carried: they must come only from
                // the destination image's label, never ride over (SOKI, #63).
                ...agentHardening({
                    CapAdd: withoutIsolationCaps(host.CapAdd),
                    Devices: host.Devices,
                    isolation,
                }),
            },
        })

        await created.start()
        this.logger.info({ new_container_id: created.id }, 'recreate started')
        return created.id
    }

    /**
     * `createContainer` for an agent, retried once WITHOUT `ExtraHosts` if the
     * daemon rejects `host-gateway` (Engine < 20.10, or no gateway IP it can
     * derive). The alias is a convenience; the container is not. On recreate
     * the source is already gone by the time we create, so failing here left
     * the agent with no container at all on every image update (#34). Any
     * other error — and a second failure — propagates untouched.
     */
    private async createAgentContainer(
        spec: Docker.ContainerCreateOptions
    ): Promise<Docker.Container> {
        try {
            return await this.docker.createContainer(spec)
        } catch (err) {
            if (!spec.HostConfig?.ExtraHosts?.length || !isHostGatewayUnsupported(err)) throw err
            this.logger.warn(
                { name: spec.name, err: (err as Error).message },
                'docker rejected the host-gateway alias — creating the container without it'
            )
            const { ExtraHosts: _dropped, ...hostConfig } = spec.HostConfig
            return this.docker.createContainer({ ...spec, HostConfig: hostConfig })
        }
    }

    /**
     * List every container labeled with kj-agent. Used by reconciliation
     * at server:hello time.
     */
    async listKjContainers(): Promise<KJContainerSummary[]> {
        const containers = await this.docker.listContainers({
            all: true,
            filters: { label: [KJ_LABEL] },
        })
        return containers.map((c) => {
            const agent_id_raw = c.Labels?.[KJ_LABEL_AGENT_ID]
            const agent_id = agent_id_raw ? Number.parseInt(agent_id_raw, 10) : null
            return {
                container_id: c.Id,
                agent_id: Number.isFinite(agent_id) ? agent_id : null,
            }
        })
    }

    /** Stop (SIGTERM, grace 10s, then SIGKILL) or force kill a container. */
    async stopContainer(container_id: string, opts: { force?: boolean } = {}): Promise<void> {
        const container = this.docker.getContainer(container_id)
        if (opts.force) {
            this.logger.warn({ container_id }, 'killing container (SIGKILL)')
            await container.kill().catch(() => undefined)
        } else {
            this.logger.info({ container_id }, 'stopping container (SIGTERM, 10s grace)')
            await container.stop({ t: 10 }).catch(() => undefined)
        }
    }

    /** Freeze a running container (SIGSTOP via cgroups). */
    async pauseContainer(container_id: string): Promise<void> {
        this.logger.info({ container_id }, 'pausing container')
        await this.docker.getContainer(container_id).pause()
    }

    /** Thaw a paused container. */
    async unpauseContainer(container_id: string): Promise<void> {
        this.logger.info({ container_id }, 'unpausing container')
        await this.docker.getContainer(container_id).unpause()
    }

    /**
     * Subscribe to the docker daemon events stream, filtered to events
     * touching kj-agent-labeled containers. Returns a readable stream
     * of newline-delimited JSON; the caller parses each line into a
     * DockerEvent.
     */
    async getEvents(): Promise<NodeJS.ReadableStream> {
        const stream = await this.docker.getEvents({
            filters: {
                type: ['container'],
                label: [KJ_LABEL],
            },
        })
        return stream as NodeJS.ReadableStream
    }

    /** Remove a stopped container. Safe to call after stop. */
    async removeContainer(container_id: string): Promise<void> {
        await this.docker
            .getContainer(container_id)
            .remove({ force: true })
            .catch(() => undefined)
    }

    /**
     * Our OWN container name. Docker sets a container's hostname to its short
     * id by default (we never override it), so `os.hostname()` is our id; we
     * inspect it to get the name. Used by the blue/green self-upgrade to tell
     * whether we're the fresh clone (`kj-supervisor-new-*`) that still has to
     * remove the old container + rename itself to the canonical name. Returns
     * null outside Docker (dev) or if the lookup fails.
     */
    async getOwnContainerName(): Promise<string | null> {
        // 1. Preferred: the name the clone was created with, injected as an env
        //    var by cloneContainerWithNewImage (the fast, explicit path).
        const fromEnv = process.env.KJ_OWN_CONTAINER?.trim()
        if (fromEnv) return fromEnv
        // 2. Our own container id from /proc, then inspect it for the name. This
        //    works under `--network host` (the Linux fleet), where os.hostname()
        //    returns the HOST name, not the container id (incident 2026-06-24).
        //    Crucially this makes the swap self-complete even on the FIRST
        //    upgrade to this fix — the clone (new image) is created by the OLD
        //    cloner without the env var, so it must fall back to /proc.
        const ownId = readOwnContainerId()
        if (ownId) {
            try {
                const info = await this.docker.getContainer(ownId).inspect()
                return info.Name.replace(/^\//, '')
            } catch {
                /* fall through */
            }
        }
        // 3. Bridge networking / dev: the container hostname defaults to the
        //    short container id, which inspect resolves to the real name.
        try {
            const info = await this.docker.getContainer(os.hostname()).inspect()
            return info.Name.replace(/^\//, '')
        } catch {
            return null
        }
    }

    /** Rename a container (dockerode `rename`). Used to finish the blue/green swap. */
    async renameContainer(id_or_name: string, new_name: string): Promise<void> {
        await this.docker.getContainer(id_or_name).rename({ name: new_name })
    }

    /**
     * Whether a container with this exact name exists. Used by the blue/green
     * swap to confirm we're still the temp-named clone BEFORE removing the
     * canonical — guards against a stale KJ_OWN_CONTAINER (after a swap+rename,
     * the env still holds the old temp name; on a restart that would otherwise
     * make us force-remove ourselves). Returns false on any lookup error.
     */
    async containerExists(name: string): Promise<boolean> {
        try {
            await this.docker.getContainer(name).inspect()
            return true
        } catch {
            return false
        }
    }

    /**
     * Remove a docker named volume. Called when the control deletes
     * an agent — without this, every deleted agent leaves a dangling
     * named volume behind. Silent on "no such volume" / "in use" so
     * the caller doesn't have to special-case.
     */
    async removeVolume(name: string): Promise<void> {
        await this.docker
            .getVolume(name)
            .remove()
            .catch(() => undefined)
    }

    /**
     * Seed a named volume with arbitrary files BEFORE the agent
     * container starts. The supervisor uses this for SHORT_TERM
     * memories: each entry is written under /home/agent/.claude/
     * memories/ inside the volume so the agent finds them on first
     * boot of the next spawn.
     *
     * Implementation: spawn a short-lived `alpine:3.20` helper that
     * mounts the volume at /v and runs a tiny script. We pull the
     * helper image once and reuse it; Alpine is ~5MB, negligible.
     * The helper exits as soon as it's done writing — no long-lived
     * sidecar.
     *
     * `files` is keyed by path relative to the mount point. Existing
     * files at the same path are overwritten; nothing else in the
     * volume is touched. `readonly` is honoured by chmod 0444; the
     * directory containing the files stays writable so future seeds
     * (e.g. a content update) can overwrite.
     */
    /**
     * Ensure the ROOT of a named volume is owned by UID 1000 (`bun`).
     *
     * A named volume is created root:root the first time it's mounted, which
     * shadows the image's build-time `chown bun:bun /home/agent`. Without
     * this, the agent (UID 1000) can't mkdir /home/agent/conv/<session> at
     * runtime → the session cwd never exists → `claude` fails with ENOENT
     * (posix_spawn) and the agent goes silent. Per-seed chowns only fix the
     * subdirs they touch, not the root, and don't run at all for agents with
     * nothing to seed — so this runs unconditionally at spawn.
     *
     * Non-recursive: it only fixes the root dir's ownership. The seeded
     * subtrees keep their own (the seed helper chowns each targetDir), so we
     * don't disturb the 0444 readonly files.
     */
    /**
     * Correr un guion de shell sobre un volumen (montado en `/v`) con el mismo
     * ayudante aislado que las copias: sin capacidades salvo leer y cambiar
     * dueños, sin escalar privilegios y borrado al terminar. El guion lo
     * construye quien llama; el volumen no tiene que tener el agente vivo.
     */
    async runVolumeScript(opts: {
        volume_name: string
        script: string
    }): Promise<{ code: number }> {
        const { code } = await this.runVolumeHelper({
            volume_name: opts.volume_name,
            script: opts.script,
        })
        return { code }
    }

    async ensureVolumeOwnership(volume_name: string): Promise<void> {
        const helperImage = 'alpine:3.20'
        const cached = await this.imageExistsLocally(helperImage)
        if (!cached) await this.pullImage(helperImage, () => {})

        const container = await this.docker.createContainer({
            Image: helperImage,
            Cmd: ['sh', '-c', 'chown 1000:1000 /v'],
            HostConfig: {
                Binds: [`${volume_name}:/v`],
                AutoRemove: false,
                CapAdd: ['CHOWN'],
            },
        })
        try {
            await container.start()
            const result = await container.wait()
            if (result.StatusCode !== 0) {
                this.logger.warn(
                    { volume_name, code: result.StatusCode },
                    'ensureVolumeOwnership helper exited non-zero (agent may hit EACCES)'
                )
            }
        } finally {
            await container.remove({ force: true }).catch(() => {})
        }
    }

    async seedVolumeFiles(opts: {
        volume_name: string
        target_dir: string // relative to /v, e.g. ".claude/memories"
        files: Array<{ path: string; content: string; readonly?: boolean }>
        /**
         * When true, wipe the contents of `target_dir` before writing.
         * Used by the spawn handler for `.claude/memories/` so files
         * that were renamed or unassigned in BD don't survive as
         * orphans in the volume. We delete the *contents*, not the
         * directory itself, so its UID/permissions are preserved.
         */
        purge?: boolean
    }): Promise<void> {
        if (opts.files.length === 0 && !opts.purge) return

        const helperImage = 'alpine:3.20'

        // Make sure the helper image is available locally. cheaper than
        // pulling every call (alpine layers are cached after the first).
        const cached = await this.imageExistsLocally(helperImage)
        if (!cached) {
            await this.pullImage(helperImage, () => {})
        }

        // Validates and shell-quotes every path before building the script;
        // a hostile path throws here and never reaches `sh`.
        const { script, targetDir } = buildSeedScript(opts)

        const container = await this.docker.createContainer({
            Image: helperImage,
            // No labels — these are throwaway, the reconcile must NOT
            // ever pick them up as agent containers.
            //
            // The script is fed over STDIN (`sh -s`), NOT through Cmd.
            // A spawn payload with many memories/skills encodes each
            // file as inline base64; the whole script can run into
            // hundreds of KB. Passing that as a process argument hits
            // the kernel's ARG_MAX and exec fails with code 255
            // ("argument list too long"). STDIN has no such limit.
            Cmd: ['sh', '-s'],
            OpenStdin: true,
            StdinOnce: true,
            AttachStdin: true,
            HostConfig: {
                // AutoRemove false: we want to inspect the logs on
                // failure. We remove the container explicitly after
                // wait().
                AutoRemove: false,
                Mounts: [
                    {
                        Type: 'volume',
                        Source: opts.volume_name,
                        Target: '/v',
                    },
                ],
                // The agent's volume is owned by the agent user (UID
                // 1000) on every directory it touches. The helper
                // runs as root but the default CapDrop:ALL also
                // removes CAP_DAC_OVERRIDE, which root needs to write
                // into a directory it doesn't own, and CAP_CHOWN, which
                // it needs to hand the seeded tree back to UID 1000 so
                // the agent can write into it (syncBuiltinSkills). Keep
                // just those two so the helper stays heavily sandboxed.
                CapDrop: ['ALL'],
                CapAdd: ['DAC_OVERRIDE', 'CHOWN'],
                SecurityOpt: ['no-new-privileges'],
            },
        })
        // Attach to STDIN BEFORE starting so the helper's `sh -s`
        // doesn't hit EOF on an empty stream. We write the script and
        // close stdin (StdinOnce makes the container's stdin close when
        // we do), then the shell runs it and exits.
        const stdin = await this.attachContainerStdin(container.id)
        await container.start()
        await new Promise<void>((resolve, reject) => {
            stdin.write(script, (err) => {
                if (err) {
                    reject(err)
                    return
                }
                stdin.end(resolve)
            })
        })
        // wait() resolves with StatusCode when the container exits.
        const result = await container.wait()
        if (result.StatusCode !== 0) {
            // Pull stdout+stderr before removing so the operator can
            // see WHY the helper failed instead of a bare exit code.
            let logsTxt = ''
            try {
                const logsBuf = await container.logs({
                    stdout: true,
                    stderr: true,
                    follow: false,
                })
                logsTxt = Buffer.isBuffer(logsBuf) ? logsBuf.toString('utf8') : String(logsBuf)
                // dockerode returns multiplexed frames when Tty:false.
                // The 8-byte header per frame can leak into the string;
                // we strip it on a best-effort basis.
                // dockerode returns multiplexed frames when Tty:false.
                // The 8-byte header per frame can leak into the string;
                // we strip non-printable bytes (keep tab/lf and >= 0x20).
                logsTxt = logsTxt
                    .split('')
                    .filter((c) => {
                        const code = c.charCodeAt(0)
                        return code === 9 || code === 10 || code >= 32
                    })
                    .join('')
                    .trim()
            } catch {
                // ignore — we still throw with what we have.
            }
            await container.remove({ force: true }).catch(() => undefined)
            throw new Error(
                `seedVolumeFiles helper exited with code ${result.StatusCode} for volume ${opts.volume_name}: ${
                    logsTxt || '(no logs captured)'
                }`
            )
        }
        await container.remove({ force: true }).catch(() => undefined)
        this.logger.info(
            {
                volume: opts.volume_name,
                target_dir: targetDir,
                file_count: opts.files.length,
            },
            'seeded volume files'
        )
    }

    /**
     * Run a throwaway alpine helper with the agent's volume mounted at /v and
     * a short shell script. Returns the exit code + (de-framed) logs. Mirrors
     * the sandboxing of `seedVolumeFiles`. The script is passed via Cmd (it's
     * short and secret-free — URLs travel as env vars so they don't show up in
     * `docker inspect`).
     */
    private async runVolumeHelper(opts: {
        volume_name: string
        script: string
        env?: string[]
        readonly?: boolean
        /** Volumes and where they go, in place of `volume_name` at /v. */
        mounts?: Array<{ source: string; target: string }>
        /** On top of DAC_OVERRIDE + CHOWN. */
        extra_caps?: string[]
        /**
         * Fire `onMarker` as soon as this string shows up in the helper's
         * output, without waiting for it to finish.
         *
         * It exists so a frozen agent thaws the moment the tar is done instead
         * of staying frozen through the upload — the difference between ~5 and
         * ~9 minutes on the biggest volume in the fleet. Polling rather than
         * streaming because the log is a handful of lines and the poll costs
         * nothing next to a tar.
         */
        marker?: string
        onMarker?: () => Promise<void>
    }): Promise<{ code: number; logs: string; stdout: string }> {
        const helperImage = 'alpine:3.20'
        if (!(await this.imageExistsLocally(helperImage)))
            await this.pullImage(helperImage, () => {})

        const container = await this.docker.createContainer({
            Image: helperImage,
            Cmd: ['sh', '-c', opts.script],
            Env: opts.env,
            HostConfig: {
                AutoRemove: false,
                Mounts: (opts.mounts ?? [{ source: opts.volume_name, target: '/v' }]).map((m) => ({
                    Type: 'volume' as const,
                    Source: m.source,
                    Target: m.target,
                    ReadOnly: !!opts.readonly,
                })),
                CapDrop: ['ALL'],
                CapAdd: ['DAC_OVERRIDE', 'CHOWN', ...(opts.extra_caps ?? [])],
                SecurityOpt: ['no-new-privileges'],
            },
        })
        let markerSeen = false
        const watchForMarker = async (): Promise<void> => {
            if (!opts.marker || !opts.onMarker) return
            while (!markerSeen) {
                await new Promise((r) => setTimeout(r, 2_000))
                if (markerSeen) return
                // STDOUT only, and at the start of a line. The helper is the
                // only writer on its stdout; stderr carries whatever the
                // tools spat out — sqlite3 prints raw file paths (agent-named,
                // newlines included), so anything derived from stderr the
                // agent can forge whole lines of. The thaw button is not the
                // agent's to press.
                const seen = await container
                    .logs({ stdout: true, stderr: true, follow: false })
                    .then((b) =>
                        demuxDockerLogs(b)
                            .stdout.split('\n')
                            .some((line) => line.startsWith(opts.marker as string))
                    )
                    .catch(() => false)
                if (seen) {
                    markerSeen = true
                    await opts.onMarker().catch(() => undefined)
                }
            }
        }
        try {
            await container.start()
            const watcher = watchForMarker()
            const result = await container.wait()
            markerSeen = true // detiene el sondeo pase lo que pase
            await watcher.catch(() => undefined)
            const logsBuf = await container
                .logs({ stdout: true, stderr: true, follow: false })
                .catch(() => Buffer.from(''))
            // `logs` (mixed, human-facing error text) vs `stdout` (frame-demuxed,
            // the ONLY stream marker parsing may trust — see demuxDockerLogs).
            return {
                code: result.StatusCode,
                logs: stripDockerFrames(logsBuf),
                stdout: demuxDockerLogs(logsBuf).stdout,
            }
        } finally {
            markerSeen = true
            await container.remove({ force: true }).catch(() => undefined)
        }
    }

    /**
     * Whether a named volume exists. Only a 404 means no: any other error
     * throws, because a backup that read "no" from a daemon hiccup would go
     * up green without the isolation volume — and a migration then deletes it.
     */
    async volumeExists(name: string): Promise<boolean> {
        try {
            await this.docker.getVolume(name).inspect()
            return true
        } catch (err) {
            if ((err as { statusCode?: number })?.statusCode === 404) return false
            throw err
        }
    }

    /**
     * Tar the agent's /home/agent volume (gzip) and PUT it straight to a
     * pre-signed R2 URL — the bytes never touch the control. If the agent has
     * an isolation-state volume (an image that isolates conversations by uid),
     * it travels in the same archive: it holds each isolated conversation's
     * HOME, and a migration deletes the source volumes once restored, so
     * leaving it out lost those conversations for good. The volumes are
     * mounted read-only; the tarball is staged in the helper's /tmp (host
     * overlay) so curl can send a Content-Length. Returns the uploaded size,
     * plus the per-part ETags when the tarball had to go up in pieces.
     *
     * **Why pieces at all** (#263): a pre-signed PUT in R2 tops out at
     * 4.995 GiB. Ailfred's volume tars to 6.21 GiB, so its nightly backup
     * failed with a bare `400` for 35 nights running. Over the limit we split
     * the file and PUT each chunk to its own pre-signed URL; the control
     * stitches them back into one object with the ETags we return here.
     *
     * Chunks are cut with `dd` on demand and deleted right after uploading,
     * so peak disk stays at "tarball + one chunk" instead of double.
     *
     * `--fail-with-body` instead of plain `-f`: R2 says WHY in the response
     * body (`EntityTooLarge`, `SignatureDoesNotMatch`…). Swallowing it is
     * what kept #263 unexplained for a month — a `400` on its own says
     * nothing.
     */
    async backupVolume(
        volume_name: string,
        upload_url: string,
        multipart?: {
            upload_id: string
            part_urls: string[]
            part_size_bytes: number
            single_put_limit_bytes: number
        },
        /** Called the instant the tar is done, before the upload starts. */
        onTarDone?: () => Promise<void>
    ): Promise<{ size_bytes: number; parts?: { part_number: number; etag: string }[] }> {
        // Guard against the control handing us a part_size_bytes that isn't
        // a positive multiple of 1 MiB. The helper cuts chunks with
        // `dd bs=1048576 count=$(( KJ_PART_SIZE / 1048576 ))`, which truncates
        // on non-multiples — each chunk would be a few bytes short of where
        // the next one's `skip` expects, and the tarball would land in R2
        // with hidden holes (no error from curl, no ETag mismatch). And with
        // `part_size_bytes = 0`, `NEEDED = (SZ + KJ_PART_SIZE - 1) / KJ_PART_SIZE`
        // divides by zero in the helper and we'd get a cryptic shell error
        // instead of the clear message the guard is here for. Fail loud here
        // rather than upload a silently corrupted backup.
        if (multipart) {
            if (multipart.part_size_bytes <= 0) {
                throw new Error(
                    `part_size_bytes must be a positive number of bytes (got ${multipart.part_size_bytes})`
                )
            }
            if (multipart.part_size_bytes % (1024 * 1024) !== 0) {
                throw new Error(
                    `part_size_bytes must be a multiple of 1 MiB (got ${multipart.part_size_bytes})`
                )
            }
        }
        // Newline-separated so the helper can read them without quoting
        // games; passed via env because the arg list would blow past ARG_MAX
        // with 60 signed URLs.
        const partUrls = multipart?.part_urls.join('\n') ?? ''
        const iso_volume_name = isolationVolumeName(volume_name)
        const withIso = await this.volumeExists(iso_volume_name)
        const script = buildBackupScript(withIso)

        const { code, logs, stdout } = await this.runVolumeHelper({
            volume_name,
            mounts: withIso
                ? [
                      { source: volume_name, target: '/v/home' },
                      { source: iso_volume_name, target: '/v/iso' },
                  ]
                : undefined,
            // For setpriv to drop the sqlite3 copies to the agent's uid.
            extra_caps: withIso ? ['SETUID', 'SETGID'] : undefined,
            script,
            // El tamaño se imprime justo después del tar: es la señal de que ya
            // no se está leyendo el volumen y el agente puede seguir.
            marker: 'KJ_BACKUP_SIZE=',
            onMarker: onTarDone,
            env: [
                `KJ_UPLOAD_URL=${upload_url}`,
                `KJ_PART_URLS=${partUrls}`,
                `KJ_PART_SIZE=${multipart?.part_size_bytes ?? 0}`,
                `KJ_SINGLE_LIMIT=${multipart?.single_put_limit_bytes ?? 0}`,
            ],
            readonly: true,
        })
        if (code !== 0) throw new Error(`backup helper exited ${code}: ${logs.slice(-400)}`)

        // Markers parse from STDOUT only, never the mixed logs. On the green
        // path stderr still carries tool noise with agent-named file paths in
        // it — and sqlite3 prints those paths RAW, newlines included, so an
        // agent can forge entire lines there (a file named
        // "evil\nKJ_PART=1:x\ny.db" defeats any anchor). The helper is the
        // only writer on its stdout: everything it says that isn't a marker
        // goes to >&2, and the multipart ETags come from R2's responses, not
        // from anything the agent can touch. Anchors stay as hygiene.
        const m = stdout.match(/^KJ_BACKUP_SIZE=(\d+)$/m)
        const size_bytes = m ? Number(m[1]) : 0

        // On success nobody reads the helper logs, so the "files were moving
        // under the tar" warning would die with the container.
        if (/^KJ_TAR_WARN=1$/m.test(stdout)) {
            this.logger.warn(
                { volume_name },
                'backup tarred while the agent kept writing; the sqlite copies inside the tar are the consistent ones'
            )
        }

        const parts: { part_number: number; etag: string }[] = []
        for (const line of stdout.matchAll(/^KJ_PART=(\d+):(\S+)$/gm)) {
            const [, number, etag] = line
            if (number && etag) parts.push({ part_number: Number(number), etag })
        }
        return parts.length > 0 ? { size_bytes, parts } : { size_bytes }
    }

    /**
     * Download a backup tarball from a pre-signed R2 URL and extract it onto
     * the agent's volume, REPLACING its contents (wipe + extract). The caller
     * must stop the container first (a running agent holds the volume). Hands
     * the root back to UID 1000 so the agent can write at boot.
     *
     * An archive that carries the isolation-state volume (see
     * `buildBackupScript`) also replaces that one. The volume is mounted in
     * any case, which creates it on a server that never had it (a migration
     * target); if the archive turned out not to carry it, it's removed again.
     */
    async restoreVolume(volume_name: string, download_url: string): Promise<void> {
        const iso_volume_name = isolationVolumeName(volume_name)
        const isoExisted = await this.volumeExists(iso_volume_name)
        const { code, logs, stdout } = await this.runVolumeHelper({
            volume_name,
            mounts: [
                { source: volume_name, target: '/v' },
                { source: iso_volume_name, target: '/iso' },
            ],
            // GNU tar sets mode and times AFTER handing a file to its owner,
            // and the isolated conversations' files aren't root's.
            extra_caps: ['FOWNER'],
            script: buildRestoreScript(),
            env: [`KJ_DOWNLOAD_URL=${download_url}`],
        })
        // Only after a clean run: a helper that died past the iso extraction
        // never printed the marker, and removing then would undo that work.
        const isoRestored = /^KJ_ISO_RESTORED=1$/m.test(stdout)
        if (code === 0 && !isoExisted && !isoRestored) await this.removeVolume(iso_volume_name)
        if (code !== 0) throw new Error(`restore helper exited ${code}: ${logs.slice(-400)}`)
    }
}

/**
 * The shell the restore helper runs: the home volume at /v, the
 * isolation-state volume at /iso.
 *
 * The layout is read from the FIRST entry only: `home/` is the two-volume
 * format, and an old archive can't produce it (all of its entries are `./…`).
 * Old archives go down the old path, and leave /iso alone.
 *
 * Both paths extract with GNU tar: it refuses to write through a symlink the
 * archive itself planted, which BusyBox's does worse — and with /iso mounted,
 * an old archive (agent-made content, taken hot) is one symlink away from it.
 * Numeric owners, so neither path resolves names against the helper's users.
 */
export function buildRestoreScript(): string {
    return [
        'set -e',
        'apk add --no-cache curl tar >/dev/null',
        'curl -fsS "$KJ_DOWNLOAD_URL" -o /tmp/b.tgz',
        'FIRST=$(tar -tzf /tmp/b.tgz | head -n 1)',
        'if [ "$FIRST" != "home/" ]; then',
        '  find /v -mindepth 1 -delete',
        '  tar -C /v --numeric-owner -xzf /tmp/b.tgz',
        '  chown 1000:1000 /v',
        '  exit 0',
        'fi',
        'find /v -mindepth 1 -delete',
        'tar -C /v --numeric-owner --strip-components=1 -xzf /tmp/b.tgz home',
        'chown 1000:1000 /v',
        'find /iso -mindepth 1 -delete',
        'tar -C /iso --numeric-owner --strip-components=1 -xzf /tmp/b.tgz iso',
        // What kj-agent-base expects of its ISO_ROOT; the archive's own entry
        // for it was stripped above.
        'chown 0:0 /iso',
        'chmod 0711 /iso',
        'echo "KJ_ISO_RESTORED=1"',
    ].join('\n')
}

/**
 * Real demultiplexing of a docker logs/attach buffer (Tty:false): each frame
 * is an 8-byte header `[type, 0, 0, 0, SIZE_BE32]` followed by SIZE payload
 * bytes; type 1 = stdout, 2 = stderr.
 *
 * This exists because `stripDockerFrames` is NOT a demux — it byte-filters
 * and concatenates, which (a) merges stderr into the same string as stdout,
 * and (b) lets printable SIZE bytes of the headers leak into the text. Fine
 * for human-facing error text; disqualifying for anything a machine parses:
 * the helper is the only writer on its stdout, while stderr carries raw
 * agent-named file paths (sqlite3 does not escape newlines in them, so an
 * agent can forge entire lines there — PR #25, 3rd security pass).
 *
 * Strict on purpose: a malformed header stops the parse and drops the rest,
 * so a truncated buffer fails closed (missing markers read as "no size")
 * instead of guessing at bytes.
 */
function demuxDockerLogs(buf: Buffer | string): { stdout: string; stderr: string } {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))
    const out: Buffer[] = []
    const err: Buffer[] = []
    let i = 0
    while (i + 8 <= b.length) {
        const type = b[i] as number
        const zeros = b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 0
        if (!zeros || type > 2) break
        const size = b.readUInt32BE(i + 4)
        const start = i + 8
        const end = start + size
        if (end > b.length) break
        const payload = b.subarray(start, end)
        if (type === 2) err.push(payload)
        else out.push(payload)
        i = end
    }
    return {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
    }
}

/**
 * dockerode returns multiplexed stdout/stderr frames when Tty:false — each
 * carries an 8-byte header that leaks into the string. Strip non-printable
 * bytes (keep tab/lf + >= 0x20), best-effort. Human-facing error text ONLY —
 * never parse markers out of this; that is what `demuxDockerLogs` is for.
 */
function stripDockerFrames(buf: Buffer | string): string {
    const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
    return s
        .split('')
        .filter((c) => {
            const code = c.charCodeAt(0)
            return code === 9 || code === 10 || code >= 32
        })
        .join('')
        .trim()
}
