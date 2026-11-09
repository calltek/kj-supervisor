/**
 * Running one SQL statement for `/sql`, with mysql2 (MySQL and MariaDB) or pg
 * (PostgreSQL). The connection is opened, used once and closed: no pool.
 *
 * Two ways in, and neither leaves the password readable on the way:
 * - `tls`: straight to the server, over TLS with the certificate verified
 *   against its name. We open the TCP connection ourselves to the address
 *   already checked (no second DNS lookup) and hand it to the driver.
 * - `tunnel`: a channel of kj-keychain's own SSH tunnel, already encrypted.
 *
 * Rows are read one by one and only the first `max_rows` are kept, so a huge
 * result does not fill this container's memory. Failures come out as a
 * `SqlFailure` with its kind; the handler words them and hides the values.
 */

import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import mysql from 'mysql2'
import pg from 'pg'

export type SqlEngine = 'mysql' | 'postgres'
export type SqlParam = string | number | boolean | null

export type SqlTransport =
    | { kind: 'tls'; address: string; port: number; servername: string }
    | { kind: 'tunnel'; stream: Duplex; host: string; port: number }

export interface SqlRunOptions {
    engine: SqlEngine
    transport: SqlTransport
    user: string
    password: string
    database: string | null
    sql: string
    params: SqlParam[]
    max_rows: number
    connect_timeout_ms: number
    statement_timeout_ms: number
}

export interface SqlResult {
    columns: string[]
    rows: unknown[][]
    row_count: number
    affected_rows?: number
    truncated: boolean
}

export type RunSql = (options: SqlRunOptions) => Promise<SqlResult>

export class SqlFailure extends Error {
    constructor(
        readonly kind: 'auth' | 'unreachable' | 'timeout' | 'tls' | 'cleartext' | 'sql',
        message: string
    ) {
        super(message)
    }
}

/** A value as JSON can carry it: dates in ISO, bytes in base64, bigints as text. */
export function jsonValue(value: unknown): unknown {
    if (value === null || value === undefined) return null
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
    }
    if (Buffer.isBuffer(value)) return value.toString('base64')
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
    if (Array.isArray(value)) return value.map(jsonValue)
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value)) out[k] = jsonValue(v)
        return out
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
    return value
}

class RowCollector {
    readonly rows: unknown[][] = []
    count = 0

    constructor(private readonly max: number) {}

    add(row: unknown[]): void {
        this.count += 1
        if (this.rows.length < this.max) this.rows.push(row.map(jsonValue))
    }
}

/** A promise that rejects after `ms`, and the way to stop the timer. */
function deadline(ms: number, onExpire: () => void): { promise: Promise<never>; clear(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            onExpire()
            reject(new SqlFailure('timeout', 'tiempo agotado'))
        }, ms)
    })
    promise.catch(() => {})
    return { promise, clear: () => clearTimeout(timer) }
}

const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ENOTFOUND',
])

/** A TLS failure: no TLS offered, or a certificate that does not hold. */
export function isTlsFailure(error: unknown): boolean {
    const e = error as { code?: string; message?: string }
    const code = e?.code ?? ''
    if (/CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|HANDSHAKE_NO_SSL|ERR_SSL|ERR_TLS/.test(code)) {
        return true
    }
    return /does not support (SSL|secure)|certificate|self[- ]signed|altname/i.test(
        e?.message ?? ''
    )
}

/** The TCP connection to the checked address; the driver then talks TLS over it. */
function connectTcp(address: string, port: number, timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = new Socket()
        const timer = setTimeout(() => {
            socket.destroy()
            reject(new SqlFailure('timeout', 'tiempo agotado al conectar'))
        }, timeoutMs)
        socket.once('error', (error: Error & { code?: string }) => {
            clearTimeout(timer)
            socket.destroy()
            reject(new SqlFailure('unreachable', error.code ?? 'conexión fallida'))
        })
        socket.connect(port, address, () => {
            clearTimeout(timer)
            socket.removeAllListeners('error')
            resolve(socket)
        })
    })
}

interface Wire {
    stream: Duplex
    /** The name TLS is verified against, or where the tunnel goes. */
    host: string
    port: number
    tls: boolean
}

async function openWire(transport: SqlTransport, timeoutMs: number): Promise<Wire> {
    if (transport.kind === 'tunnel') {
        return { stream: transport.stream, host: transport.host, port: transport.port, tls: false }
    }
    const socket = await connectTcp(transport.address, transport.port, timeoutMs)
    return { stream: socket, host: transport.servername, port: transport.port, tls: true }
}

// ── MySQL / MariaDB ─────────────────────────────────────────────────────

function mysqlFailure(error: unknown): SqlFailure {
    if (error instanceof SqlFailure) return error
    const e = error as { code?: string; errno?: number; message?: string; sqlMessage?: string }
    const code = e?.code ?? ''
    if (code === 'MYSQL_CLEAR_PASSWORD_NOT_ENABLED') return new SqlFailure('cleartext', code)
    if (isTlsFailure(error)) return new SqlFailure('tls', e?.message ?? code)
    if (
        code === 'ER_ACCESS_DENIED_ERROR' ||
        code === 'ER_DBACCESS_DENIED_ERROR' ||
        code === 'ER_NOT_SUPPORTED_AUTH_MODE' ||
        e?.errno === 1045
    ) {
        return new SqlFailure('auth', e.sqlMessage ?? e.message ?? code)
    }
    if (code === 'PROTOCOL_SEQUENCE_TIMEOUT' || code === 'ETIMEDOUT') {
        return new SqlFailure('timeout', code)
    }
    if (NETWORK_CODES.has(code) || code.startsWith('PROTOCOL_')) {
        return new SqlFailure('unreachable', code)
    }
    return new SqlFailure('sql', e?.sqlMessage ?? e?.message ?? 'error')
}

async function runMysql(o: SqlRunOptions, wire: Wire): Promise<SqlResult> {
    const connection = mysql.createConnection({
        stream: wire.stream,
        // With `ssl`, mysql2 verifies the certificate against `host`.
        host: wire.host,
        port: wire.port,
        ...(wire.tls
            ? { ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } }
            : {}),
        user: o.user,
        password: o.password,
        database: o.database ?? undefined,
        connectTimeout: o.connect_timeout_ms,
        multipleStatements: false,
        // Never the password as is (`mysql_clear_password`); mysql2's default,
        // written down so nobody turns it on.
        enableCleartextPlugin: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
    })
    connection.on('error', () => {})
    const stop = deadline(o.connect_timeout_ms + o.statement_timeout_ms, () => connection.destroy())
    try {
        await Promise.race([
            new Promise<void>((resolve, reject) => {
                connection.connect((err) => (err ? reject(mysqlFailure(err)) : resolve()))
            }),
            stop.promise,
        ])
        const collected = new RowCollector(o.max_rows)
        let columns: string[] = []
        let affected: number | undefined
        await Promise.race([
            new Promise<void>((resolve, reject) => {
                const query = connection.query({
                    sql: o.sql,
                    values: o.params,
                    rowsAsArray: true,
                    timeout: o.statement_timeout_ms,
                })
                query.on('fields', (fields: { name: string }[]) => {
                    columns = (fields ?? []).map((f) => f.name)
                })
                query.on('result', (row: unknown) => {
                    if (Array.isArray(row)) collected.add(row)
                    else if (row && typeof row === 'object' && 'affectedRows' in row) {
                        affected = Number((row as { affectedRows: unknown }).affectedRows)
                    }
                })
                query.on('error', (err: unknown) => reject(mysqlFailure(err)))
                query.on('end', () => resolve())
            }),
            stop.promise,
        ])
        return {
            columns,
            rows: collected.rows,
            row_count: collected.count,
            ...(affected !== undefined ? { affected_rows: affected } : {}),
            truncated: collected.count > collected.rows.length,
        }
    } finally {
        stop.clear()
        connection.destroy()
    }
}

// ── PostgreSQL ──────────────────────────────────────────────────────────

/**
 * pg calls `connect(port, host)` on its stream and waits for `connect`. Ours
 * is already open: it only has to say so.
 */
function connectedStream(stream: Duplex): Duplex {
    const s = stream as Duplex & Record<string, unknown>
    s.setNoDelay = () => s
    s.setKeepAlive = () => s
    s.connect = () => {
        process.nextTick(() => s.emit('connect'))
        return s
    }
    return s
}

export const CLEARTEXT_REFUSED = 'KJ_CLEARTEXT_REFUSED'

/**
 * A server that asks for the password as is (PostgreSQL `AuthenticationCleartextPassword`)
 * gets nothing: whoever answers like that could be anyone, and MD5/SCRAM never
 * hand over the password. pg binds its handler when it connects, so replacing
 * it on the instance before that is enough.
 */
function refuseCleartext(client: pg.Client): void {
    const c = client as unknown as {
        _handleAuthCleartextPassword: () => void
        connection: { emit(event: string, error: Error): void }
    }
    c._handleAuthCleartextPassword = () => {
        const error = Object.assign(new Error('el servidor pide la contraseña sin cifrar'), {
            code: CLEARTEXT_REFUSED,
        })
        c.connection.emit('error', error)
    }
}

function pgFailure(error: unknown): SqlFailure {
    if (error instanceof SqlFailure) return error
    const e = error as { code?: string; message?: string }
    const code = e?.code ?? ''
    if (code === CLEARTEXT_REFUSED) return new SqlFailure('cleartext', code)
    if (code === '28P01' || code === '28000' || code === '3D000') {
        return new SqlFailure('auth', e.message ?? code)
    }
    if (code === '57014') return new SqlFailure('timeout', e.message ?? code)
    if (/^[0-9A-Z]{5}$/.test(code)) return new SqlFailure('sql', e.message ?? code)
    if (isTlsFailure(error)) return new SqlFailure('tls', e?.message ?? code)
    const message = e?.message ?? ''
    if (/timeout/i.test(message)) return new SqlFailure('timeout', message)
    return new SqlFailure('unreachable', code || message || 'error')
}

async function runPostgres(o: SqlRunOptions, wire: Wire): Promise<SqlResult> {
    const client = new pg.Client({
        // With `ssl`, pg verifies the certificate against `host`.
        host: wire.host,
        port: wire.port,
        stream: () => connectedStream(wire.stream) as never,
        ssl: wire.tls ? { rejectUnauthorized: true, minVersion: 'TLSv1.2' } : false,
        user: o.user,
        password: o.password,
        database: o.database ?? undefined,
        connectionTimeoutMillis: o.connect_timeout_ms,
        statement_timeout: o.statement_timeout_ms,
        query_timeout: o.statement_timeout_ms + 2_000,
        application_name: 'kujira',
    })
    client.on('error', () => {})
    refuseCleartext(client)
    const stop = deadline(o.connect_timeout_ms + o.statement_timeout_ms + 5_000, () => {
        client.end().catch(() => {})
    })
    try {
        await Promise.race([
            client.connect().catch((err) => Promise.reject(pgFailure(err))),
            stop.promise,
        ])
        const collected = new RowCollector(o.max_rows)
        type PgEnd = { fields: { name: string }[]; command: string; rowCount: number | null }
        const result = await Promise.race([
            new Promise<PgEnd>((resolve, reject) => {
                // Extended protocol: one statement only, even without parameters.
                const query = new pg.Query({
                    text: o.sql,
                    values: o.params,
                    rowMode: 'array',
                    queryMode: 'extended',
                } as never) as unknown as NodeJS.EventEmitter
                query.on('row', (row: unknown[]) => collected.add(row))
                query.on('error', (err: unknown) => reject(pgFailure(err)))
                query.on('end', (res: PgEnd) => resolve(res))
                client.query(query as never)
            }),
            stop.promise,
        ])
        const columns = (result.fields ?? []).map((f) => f.name)
        // `UPDATE … RETURNING` has columns too, and still changed rows.
        const changed = result.command !== 'SELECT' && result.rowCount !== null
        return {
            columns,
            rows: collected.rows,
            row_count: collected.count,
            ...(changed ? { affected_rows: result.rowCount as number } : {}),
            truncated: collected.count > collected.rows.length,
        }
    } finally {
        stop.clear()
        client.end().catch(() => {})
    }
}

export const runSql: RunSql = async (options) => {
    const wire = await openWire(options.transport, options.connect_timeout_ms)
    try {
        return options.engine === 'postgres'
            ? await runPostgres(options, wire)
            : await runMysql(options, wire)
    } finally {
        if (options.transport.kind === 'tls') wire.stream.destroy()
    }
}
