/**
 * `POST /sql`: one SQL statement against a database whose password the agent
 * never sees (credenciales-por-referencia.md, «Base de datos»; the `kj-sql`
 * CLI of kj-agent-base calls this).
 *
 * ```
 * { credential, engine?: 'mysql'|'postgres', host?, port?, database?, user?,
 *   ssh?: { credential, host?, port?, user? },
 *   sql, params?: (string|number|boolean|null)[], max_rows? }
 * → { ok: true, columns, rows, row_count, affected_rows?, truncated }
 * ```
 *
 * The transport is kj-keychain's own, end to end: with `ssh` it opens the
 * tunnel itself (key from the SSH credential, signed here) and talks to the
 * database through it; without, it connects to the checked public address.
 * Nothing goes through the agent's container, which therefore cannot pose as
 * the server to catch the password.
 *
 * The password only goes to the first hop that is one of the DB credential's
 * destinations: the SSH server when tunnelled (the database host is then
 * relative to it, so 127.0.0.1 is fine), the database itself otherwise. The
 * first hop must be a public address. The body may change every non-secret
 * field; never the password.
 */

import { authenticate, credentialName, readJsonObject } from './agent-request'
import {
    type CredentialRef,
    FIELD_LABELS,
    type FieldLookup,
    assertDestination,
    lookupField,
    noDestinationError,
    parsePort,
} from './credential-fields'
import { KeychainError, errorResponse } from './errors'
import type { KeychainLog } from './log'
import { type LookupAll, defaultLookup, resolvePublicAddress } from './public-address'
import { collectVariants, redactJson, redactText } from './redact'
import type { AgentTokenRegistry } from './registry'
import type { Resolve } from './resolver'
import { normalizeHost } from './sites'
import { SSH_KEY_FIELD, parseCredentialKey } from './ssh-handler'
import { type OpenSshTunnel, type SshTunnel, SshTunnelError, openSshTunnel } from './ssh-tunnel'
import {
    type RunSql,
    type SqlEngine,
    SqlFailure,
    type SqlParam,
    type SqlTransport,
    runSql,
} from './sql-engines'

export const SQL_PATH = '/sql'

export const CONNECT_TIMEOUT_MS = 15_000
export const STATEMENT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_ROWS = 1000
export const MAX_ROWS_CAP = 10_000

const MAX_BODY_BYTES = 1024 * 1024
const MAX_PARAMS = 10_000
const MAX_TEXT = 255

export interface SqlHandlerDeps {
    registry: AgentTokenRegistry
    resolve: Resolve
    log: KeychainLog
    lookup?: LookupAll
    openTunnel?: OpenSshTunnel
    runSql?: RunSql
}

/** What the body asks for, validated. */
export interface SqlRequest {
    credential: string
    engine: SqlEngine | null
    host: string | null
    port: number | null
    database: string | null
    user: string | null
    ssh: {
        credential: string
        host: string | null
        port: number | null
        user: string | null
    } | null
    sql: string
    params: SqlParam[]
    max_rows: number
}

function bad(message: string): KeychainError {
    return new KeychainError('KEYCHAIN_BAD_REQUEST', message)
}

function optionalText(value: unknown, what: string): string | null {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || value.length > MAX_TEXT) throw bad(`${what} no es válido.`)
    const text = value.trim()
    return text ? text : null
}

function optionalHost(value: unknown, what: string): string | null {
    const text = optionalText(value, what)
    if (text === null) return null
    const host = normalizeHost(text)
    if (!host || /[\s/@?#]/.test(host)) throw bad(`${what} no es válido.`)
    return host
}

export function parseSqlRequest(body: Record<string, unknown>): SqlRequest {
    if ('password' in body) {
        throw bad(
            'La contraseña nunca va en la petición: la pone Kujira desde la credencial. Quita ' +
                'el campo password.'
        )
    }
    const credential = credentialName(body.credential)
    let engine: SqlEngine | null = null
    if (body.engine !== undefined && body.engine !== null) {
        if (body.engine !== 'mysql' && body.engine !== 'postgres') {
            throw bad('engine tiene que ser "mysql" (también MariaDB) o "postgres".')
        }
        engine = body.engine
    }
    let ssh: SqlRequest['ssh'] = null
    if (body.ssh !== undefined && body.ssh !== null) {
        if (typeof body.ssh !== 'object' || Array.isArray(body.ssh)) {
            throw bad('ssh tiene que ser un objeto { credential, host?, port?, user? }.')
        }
        const s = body.ssh as Record<string, unknown>
        if ('password' in s) throw bad('La clave SSH sale de la credencial, no de la petición.')
        ssh = {
            credential: credentialName(s.credential, 'la credencial SSH'),
            host: optionalHost(s.host, 'El host SSH'),
            port: parsePort(s.port, 'la conexión SSH'),
            user: optionalText(s.user, 'El usuario SSH'),
        }
    }
    if (typeof body.sql !== 'string' || !body.sql.trim()) throw bad('Falta la consulta (sql).')
    let params: SqlParam[] = []
    if (body.params !== undefined && body.params !== null) {
        if (!Array.isArray(body.params) || body.params.length > MAX_PARAMS) {
            throw bad('params tiene que ser una lista de valores.')
        }
        for (const p of body.params) {
            const ok =
                p === null ||
                typeof p === 'string' ||
                typeof p === 'boolean' ||
                (typeof p === 'number' && Number.isFinite(p))
            if (!ok) throw bad('Cada valor de params es texto, número, true/false o null.')
        }
        params = body.params as SqlParam[]
    }
    let max_rows = DEFAULT_MAX_ROWS
    if (body.max_rows !== undefined && body.max_rows !== null) {
        if (!Number.isInteger(body.max_rows) || (body.max_rows as number) < 1) {
            throw bad('max_rows tiene que ser un entero positivo.')
        }
        max_rows = Math.min(body.max_rows as number, MAX_ROWS_CAP)
    }
    return {
        credential,
        engine,
        host: optionalHost(body.host, 'El host'),
        port: parsePort(body.port, 'la base de datos'),
        database: optionalText(body.database, 'database'),
        user: optionalText(body.user, 'El usuario'),
        ssh,
        sql: body.sql,
        params,
        max_rows,
    }
}

/** postgres on 5432, mysql (and MariaDB) otherwise, unless the body says. */
export function chooseEngine(engine: SqlEngine | null, port: number | null): SqlEngine {
    if (engine) return engine
    return port === 5432 ? 'postgres' : 'mysql'
}

export function defaultPort(engine: SqlEngine): number {
    return engine === 'postgres' ? 5432 : 3306
}

const found = (l: FieldLookup): string | null => (l.status === 'found' ? l.value : null)

export function createSqlHandler(deps: SqlHandlerDeps) {
    const lookup = deps.lookup ?? defaultLookup
    const openTunnel = deps.openTunnel ?? openSshTunnel
    const run = deps.runSql ?? runSql

    return async function handleSql(request: Request): Promise<Response> {
        const started = Date.now()
        let agent_id: number | null = null
        let host: string | null = null
        let variants: string[] = []
        try {
            const caller = authenticate(request, deps.registry)
            agent_id = caller.agent_id
            const req = parseSqlRequest(await readJsonObject(request, MAX_BODY_BYTES))
            const ref: CredentialRef = {
                agent_id: caller.agent_id,
                conversation_session_id: caller.session,
                credential: req.credential,
            }
            const sshRef: CredentialRef | null = req.ssh
                ? { ...ref, credential: req.ssh.credential }
                : null

            // Every field at once: each is a round trip to the backend.
            const [dbHost, dbPort, dbUser, dbName, dbPassword, sshKey, sshHost, sshPort, sshUser] =
                await Promise.all([
                    lookupField(deps.resolve, ref, FIELD_LABELS.host),
                    lookupField(deps.resolve, ref, FIELD_LABELS.port),
                    lookupField(deps.resolve, ref, FIELD_LABELS.user),
                    lookupField(deps.resolve, ref, FIELD_LABELS.database),
                    lookupField(deps.resolve, ref, FIELD_LABELS.password),
                    sshRef ? lookupField(deps.resolve, sshRef, [SSH_KEY_FIELD]) : null,
                    sshRef ? lookupField(deps.resolve, sshRef, FIELD_LABELS.host) : null,
                    sshRef ? lookupField(deps.resolve, sshRef, FIELD_LABELS.port) : null,
                    sshRef ? lookupField(deps.resolve, sshRef, FIELD_LABELS.user) : null,
                ])
            if (dbPassword.status === 'found') variants = collectVariants([dbPassword.value])
            const label = `«${req.credential}»`

            // Where the first hop is.
            let ssh: {
                host: string
                port: number
                user: string
                key: ReturnType<typeof parseCredentialKey>
            } | null = null
            if (req.ssh && sshKey && sshHost && sshPort && sshUser) {
                const sshLabel = `«${req.ssh.credential}»`
                // An SSH credential usually has no destination (its key needs none),
                // and then the backend gives none of its other fields.
                const missing = (what: string, field: string, lookup: FieldLookup) =>
                    new KeychainError(
                        'KEYCHAIN_NO_FIELD',
                        lookup.status === 'no_destination'
                            ? `Kujira no lee ${what} de ${sshLabel} porque la credencial no ` +
                                  `tiene destinos. Pásalo en ${field}.`
                            : `La credencial SSH ${sshLabel} no tiene ${what}. Pásalo en ${field}.`
                    )
                const sHost = req.ssh.host ?? optionalHost(found(sshHost), `El host de ${sshLabel}`)
                if (!sHost) throw missing('el host', 'ssh.host', sshHost)
                const sUser = req.ssh.user ?? found(sshUser)
                if (!sUser) throw missing('el usuario', 'ssh.user', sshUser)
                if (sshKey.status !== 'found') {
                    throw new KeychainError(
                        'KEYCHAIN_NO_FIELD',
                        `La credencial ${sshLabel} no lleva una clave privada SSH.`
                    )
                }
                ssh = {
                    host: sHost,
                    port: req.ssh.port ?? parsePort(found(sshPort), sshLabel) ?? 22,
                    user: sUser,
                    key: parseCredentialKey(req.ssh.credential, sshKey.value),
                }
            }
            const credentialHost = optionalHost(found(dbHost), `El host de ${label}`)
            const databaseHost = req.host ?? credentialHost ?? (ssh ? '127.0.0.1' : null)
            const firstHop = ssh ? ssh.host : databaseHost
            host = firstHop
            if (dbPassword.status === 'no_destination')
                throw noDestinationError(req.credential, firstHop)
            if (!databaseHost) {
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no tiene host. Pásalo en host.`
                )
            }
            if (dbPassword.status === 'absent') {
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no tiene contraseña. Pide al operador que la añada ` +
                        'en Credenciales.'
                )
            }
            // 1. The password only goes to a destination of its credential.
            assertDestination(req.credential, firstHop ?? databaseHost, dbPassword.sites)
            const user = req.user ?? found(dbUser)
            if (!user) {
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no tiene usuario. Pásalo en user.`
                )
            }
            const credentialPort = parsePort(found(dbPort), label)
            const engine = chooseEngine(req.engine, req.port ?? credentialPort)
            const port = req.port ?? credentialPort ?? defaultPort(engine)

            // 2. The first hop must be public; we connect to the address checked.
            const address = await resolvePublicAddress(firstHop ?? databaseHost, lookup)

            // 3. Our own transport, end to end.
            let tunnel: SshTunnel | null = null
            try {
                let transport: SqlTransport
                if (ssh) {
                    tunnel = await openTunnel({
                        address: address.address,
                        port: ssh.port,
                        username: ssh.user,
                        key: ssh.key,
                        dst_host: databaseHost,
                        dst_port: port,
                        timeout_ms: CONNECT_TIMEOUT_MS,
                    }).catch((error) => {
                        throw tunnelError(error, ssh, databaseHost, port)
                    })
                    transport = { kind: 'stream', stream: tunnel.stream, host: databaseHost, port }
                } else {
                    transport = { kind: 'tcp', address: address.address, port }
                }
                const result = await run({
                    engine,
                    transport,
                    user,
                    password: dbPassword.value,
                    database: req.database ?? found(dbName),
                    sql: req.sql,
                    params: req.params,
                    max_rows: req.max_rows,
                    connect_timeout_ms: CONNECT_TIMEOUT_MS,
                    statement_timeout_ms: STATEMENT_TIMEOUT_MS,
                }).catch((error) => {
                    throw sqlError(error, label, user, databaseHost, port)
                })
                deps.log('info', 'sql', {
                    agent_id,
                    host,
                    engine,
                    tunnel: ssh !== null,
                    row_count: result.row_count,
                    truncated: result.truncated,
                    ms: Date.now() - started,
                })
                return Response.json(redactJson({ ok: true, ...result }, variants))
            } finally {
                tunnel?.close()
            }
        } catch (error) {
            if (error instanceof KeychainError) {
                deps.log('warn', 'sql refused', {
                    agent_id,
                    host,
                    code: error.code,
                    status: error.status,
                })
                return errorResponse(
                    new KeychainError(error.code, redactText(error.message, variants), error.status)
                )
            }
            deps.log('error', 'sql failed', { agent_id, host })
            return errorResponse(
                new KeychainError(
                    'KEYCHAIN_UNAVAILABLE',
                    'No se ha podido ejecutar la consulta con la credencial.'
                )
            )
        }
    }
}

function tunnelError(
    error: unknown,
    ssh: { host: string; port: number; user: string },
    dbHost: string,
    dbPort: number
): KeychainError {
    const where = `${ssh.host}:${ssh.port}`
    if (!(error instanceof SshTunnelError)) {
        return new KeychainError(
            'KEYCHAIN_SSH_FAILED',
            `No se ha podido abrir el túnel SSH a ${where}.`
        )
    }
    const message = {
        auth: `El servidor SSH ${where} no ha aceptado la clave para el usuario ${ssh.user}.`,
        timeout: `El servidor SSH ${where} no contesta (${CONNECT_TIMEOUT_MS / 1000} s).`,
        unreachable: `No se ha podido conectar con el servidor SSH ${where} (${error.message}).`,
        forward:
            `El servidor SSH ${where} no deja abrir una conexión a ${dbHost}:${dbPort}. Revisa ` +
            'que la base de datos escuche ahí, vista desde ese servidor.',
    }[error.reason]
    return new KeychainError('KEYCHAIN_SSH_FAILED', message)
}

function sqlError(
    error: unknown,
    label: string,
    user: string,
    host: string,
    port: number
): KeychainError {
    if (!(error instanceof SqlFailure)) {
        return new KeychainError(
            'KEYCHAIN_DB_UNREACHABLE',
            `No se ha podido hablar con la base de datos en ${host}:${port}.`
        )
    }
    switch (error.kind) {
        case 'auth':
            return new KeychainError(
                'KEYCHAIN_DB_AUTH_FAILED',
                `La base de datos ha rechazado al usuario ${user} con la contraseña de ${label} ` +
                    `(${error.message}). Pide al operador que revise la credencial.`
            )
        case 'unreachable':
            return new KeychainError(
                'KEYCHAIN_DB_UNREACHABLE',
                `No se ha podido conectar con la base de datos en ${host}:${port} (${error.message}).`
            )
        case 'timeout':
            return new KeychainError(
                'KEYCHAIN_DB_TIMEOUT',
                'La base de datos no ha contestado a tiempo (máximo ' +
                    `${CONNECT_TIMEOUT_MS / 1000} s para conectar y ` +
                    `${STATEMENT_TIMEOUT_MS / 1000} s por consulta).`
            )
        case 'sql':
            return new KeychainError(
                'KEYCHAIN_SQL_ERROR',
                `La base de datos ha devuelto un error: ${error.message}`
            )
    }
}
