/**
 * `POST /mail/read`: reads a mailbox over IMAP with a credential whose
 * password the agent never sees (the `kj-mail` CLI of kj-agent-base, its
 * `folders`, `search`, `read`, `attachment`, `mark` and `move` commands).
 *
 * ```
 * { credential, op: 'folders' }
 * { credential, op: 'search', folder?, query?: { from, to, subject, text, since, before,
 *   unseen, flagged }, limit? }
 * { credential, op: 'read', folder?, uid, mark_seen? }
 * { credential, op: 'attachment', folder?, uid, index }
 * { credential, op: 'mark', folder?, uids, seen?, flagged? }
 * { credential, op: 'move', folder?, uids, to }
 * ```
 *
 * Nothing is deleted: there is no op for it, and `move` is how a message
 * leaves a folder. Host, port, user and password come from the credential
 * (`imap_host` first, then `host`); a credential without a host may name it
 * in the body, and either way the password only goes to one of its
 * destinations, on a public address, over TLS (993 from the first byte, any
 * other port with STARTTLS required), with the certificate checked against
 * the name.
 */

import { convert } from 'html-to-text'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

import { authenticate, credentialName, readJsonObject } from './agent-request'
import {
    type CredentialRef,
    assertDestination,
    lookupField,
    noDestinationError,
    parsePort,
} from './credential-fields'
import { KeychainError, errorResponse } from './errors'
import { ConcurrencyLimit } from './limits'
import type { KeychainLog } from './log'
import { type LookupAll, defaultLookup, resolvePublicAddress } from './public-address'
import { collectVariants, redactJson, redactText } from './redact'
import type { AgentTokenRegistry } from './registry'
import type { Resolve } from './resolver'
import { normalizeHost } from './sites'

export const MAIL_READ_PATH = '/mail/read'

export const IMAP_LABELS = {
    host: ['imap_host', 'imap_server', 'host', 'hostname', 'server'],
    port: ['imap_port', 'port'],
    user: ['imap_user', 'user', 'username', 'email'],
    password: ['imap_password', 'password', 'pass'],
} as const

export const DEFAULT_IMAP_PORT = 993
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100
export const MAX_UIDS = 500
/** A message bigger than this is not downloaded whole (attachments included). */
export const MAX_MESSAGE_BYTES = 30 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
/** The body handed to the agent; the rest is cut and said so. */
export const MAX_TEXT_CHARS = 200_000
export const MAX_CONCURRENT_READS = 4

export type ImapOp = 'folders' | 'search' | 'read' | 'attachment' | 'mark' | 'move'

export interface ImapQuery {
    from?: string
    to?: string
    subject?: string
    text?: string
    since?: string
    before?: string
    unseen?: boolean
    flagged?: boolean
}

export interface ImapRequest {
    credential: string
    op: ImapOp
    host: string | null
    folder: string
    query: ImapQuery
    limit: number
    uid: number | null
    uids: number[]
    index: number | null
    mark_seen: boolean
    seen: boolean | null
    flagged: boolean | null
    to: string | null
}

export interface ImapConnectOptions {
    address: string
    servername: string | null
    port: number
    secure: boolean
    user: string
    password: string
}

export interface ImapSummary {
    uid: number
    date: string | null
    from: string
    to: string
    subject: string
    seen: boolean
    flagged: boolean
    size: number
}

/** What the handler needs from a mailbox; the real one is `connectImapFlow`. */
export interface ImapSession {
    folders(): Promise<{ path: string; special_use: string | null }[]>
    search(
        folder: string,
        query: ImapQuery,
        limit: number
    ): Promise<{ total: number; messages: ImapSummary[] }>
    size(folder: string, uid: number): Promise<number | null>
    source(folder: string, uid: number, markSeen: boolean): Promise<Buffer | null>
    flags(
        folder: string,
        uids: number[],
        seen: boolean | null,
        flagged: boolean | null
    ): Promise<void>
    move(folder: string, uids: number[], to: string): Promise<void>
    close(): Promise<void>
}

export type ConnectImap = (options: ImapConnectOptions) => Promise<ImapSession>

export class ImapFailure extends Error {
    constructor(
        readonly kind: 'auth' | 'tls' | 'unreachable' | 'command',
        message: string
    ) {
        super(message)
    }
}

export interface ImapHandlerDeps {
    registry: AgentTokenRegistry
    resolve: Resolve
    log: KeychainLog
    lookup?: LookupAll
    connect?: ConnectImap
}

function bad(message: string): KeychainError {
    return new KeychainError('KEYCHAIN_BAD_REQUEST', message)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
const CONTROL = /[\u0000-\u001f\u007f]/
const OPS: ImapOp[] = ['folders', 'search', 'read', 'attachment', 'mark', 'move']

function folderName(value: unknown, what: string, fallback: string | null): string {
    if (value === undefined || value === null || value === '') {
        if (fallback !== null) return fallback
        throw bad(`Falta ${what}.`)
    }
    if (typeof value !== 'string' || CONTROL.test(value) || value.length > 300) {
        throw bad(`${what} no es una carpeta válida.`)
    }
    return value
}

function positiveInt(value: unknown, what: string): number {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(n) || n < 1) throw bad(`${what} tiene que ser un número entero positivo.`)
    return n
}

function optionalBool(value: unknown, what: string): boolean | null {
    if (value === undefined || value === null) return null
    if (typeof value !== 'boolean') throw bad(`${what} es true o false.`)
    return value
}

function queryText(value: unknown, what: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string' || CONTROL.test(value) || value.length > 500) {
        throw bad(`${what} no es un texto válido para buscar.`)
    }
    return value
}

function queryDate(value: unknown, what: string): string | undefined {
    const text = queryText(value, what)
    if (text === undefined) return undefined
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
        throw bad(`${what} es una fecha AAAA-MM-DD.`)
    }
    return text
}

export function parseImapRequest(body: Record<string, unknown>): ImapRequest {
    if ('password' in body) {
        throw bad('La contraseña nunca va en la petición: la pone Kujira desde la credencial.')
    }
    const credential = credentialName(body.credential)
    const op = body.op as ImapOp
    if (!OPS.includes(op)) throw bad(`op es una de: ${OPS.join(', ')}.`)
    let host: string | null = null
    if (body.host !== undefined && body.host !== null && body.host !== '') {
        if (typeof body.host !== 'string') throw bad('host no es un servidor válido.')
        host = normalizeHost(body.host)
        if (!host || /[\s/@?#:]/.test(host)) throw bad('host no es un servidor válido.')
    }
    const q = (body.query ?? {}) as Record<string, unknown>
    if (typeof q !== 'object' || Array.isArray(q)) throw bad('query tiene que ser un objeto.')
    const query: ImapQuery = {
        from: queryText(q.from, 'query.from'),
        to: queryText(q.to, 'query.to'),
        subject: queryText(q.subject, 'query.subject'),
        text: queryText(q.text, 'query.text'),
        since: queryDate(q.since, 'query.since'),
        before: queryDate(q.before, 'query.before'),
        unseen: optionalBool(q.unseen, 'query.unseen') ?? undefined,
        flagged: optionalBool(q.flagged, 'query.flagged') ?? undefined,
    }
    const limit =
        body.limit === undefined || body.limit === null
            ? DEFAULT_LIMIT
            : Math.min(positiveInt(body.limit, 'limit'), MAX_LIMIT)
    const needsUid = op === 'read' || op === 'attachment'
    const uid = needsUid ? positiveInt(body.uid, 'uid') : null
    const index = op === 'attachment' ? positiveInt(body.index, 'index') : null
    let uids: number[] = []
    if (op === 'mark' || op === 'move') {
        if (!Array.isArray(body.uids) || body.uids.length === 0) throw bad('Falta uids.')
        if (body.uids.length > MAX_UIDS) throw bad(`Como mucho ${MAX_UIDS} mensajes a la vez.`)
        uids = body.uids.map((u) => positiveInt(u, 'uids'))
    }
    const seen = optionalBool(body.seen, 'seen')
    const flagged = optionalBool(body.flagged, 'flagged')
    if (op === 'mark' && seen === null && flagged === null) {
        throw bad('Di qué marcar: seen y/o flagged.')
    }
    return {
        credential,
        op,
        host,
        folder: folderName(body.folder, 'folder', 'INBOX'),
        query,
        limit,
        uid,
        uids,
        index,
        mark_seen: optionalBool(body.mark_seen, 'mark_seen') ?? false,
        seen,
        flagged,
        to: op === 'move' ? folderName(body.to, 'to (la carpeta de destino)', null) : null,
    }
}

function addressText(value: unknown): string {
    const v = value as { text?: string } | { text?: string }[] | undefined
    if (!v) return ''
    if (Array.isArray(v))
        return v
            .map((x) => x.text ?? '')
            .filter(Boolean)
            .join(', ')
    return v.text ?? ''
}

function envelopeAddresses(list: { name?: string; address?: string }[] | undefined): string {
    return (list ?? [])
        .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
        .join(', ')
}

/** HTML read for the text of a message; past this it is cut, not converted. */
export const MAX_HTML_CHARS = MAX_TEXT_CHARS * 4

/**
 * The text of an HTML body, with html-to-text (htmlparser2, a linear
 * tokenizer) and a cap first: the mail is written by anyone who can reach the
 * mailbox, and kj-keychain is one process for the whole fleet (SOKI, #106: a
 * lazy `<script>…</script>` regex took hours on unclosed tags).
 */
export function htmlToText(input: string): string {
    const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input
    return convert(html, {
        wordwrap: false,
        selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' },
        ],
    })
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

/** The real IMAP client. */
export const connectImapFlow: ConnectImap = async (o) => {
    const client = new ImapFlow({
        host: o.address,
        port: o.port,
        secure: o.secure,
        doSTARTTLS: o.secure ? undefined : true,
        ...(o.servername ? { servername: o.servername } : {}),
        tls: {
            ...(o.servername ? { servername: o.servername } : {}),
            minVersion: 'TLSv1.2',
            rejectUnauthorized: true,
        },
        auth: { user: o.user, pass: o.password },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        clientInfo: { name: 'Kujira' },
    })
    client.on('error', () => {})
    try {
        await client.connect()
    } catch (error) {
        client.close()
        throw imapFailure(error)
    }

    async function inFolder<T>(folder: string, run: () => Promise<T>): Promise<T> {
        let lock: { release: () => void }
        try {
            lock = await client.getMailboxLock(folder)
        } catch (error) {
            throw new ImapFailure(
                'command',
                `no se puede abrir la carpeta «${folder}» (${message(error)})`
            )
        }
        try {
            return await run()
        } catch (error) {
            throw error instanceof ImapFailure ? error : imapFailure(error)
        } finally {
            lock.release()
        }
    }

    return {
        folders: async () => {
            const list = await client.list().catch((e) => {
                throw imapFailure(e)
            })
            return list.map((f) => ({ path: f.path, special_use: f.specialUse ?? null }))
        },
        search: (folder, query, limit) =>
            inFolder(folder, async () => {
                const criteria: Record<string, unknown> = {}
                if (query.from) criteria.from = query.from
                if (query.to) criteria.to = query.to
                if (query.subject) criteria.subject = query.subject
                if (query.text) criteria.body = query.text
                if (query.since) criteria.since = new Date(query.since)
                if (query.before) criteria.before = new Date(query.before)
                if (query.unseen !== undefined) criteria.seen = !query.unseen
                if (query.flagged !== undefined) criteria.flagged = query.flagged
                if (Object.keys(criteria).length === 0) criteria.all = true
                const found = (await client.search(criteria, { uid: true })) || []
                const newest = [...found].sort((a, b) => b - a).slice(0, limit)
                if (newest.length === 0) return { total: found.length, messages: [] }
                const rows = await client.fetchAll(
                    newest,
                    { uid: true, envelope: true, flags: true, size: true, internalDate: true },
                    { uid: true }
                )
                const messages = rows
                    .map((m) => ({
                        uid: m.uid,
                        date:
                            (m.envelope?.date ?? m.internalDate)
                                ? new Date(
                                      m.envelope?.date ?? (m.internalDate as Date)
                                  ).toISOString()
                                : null,
                        from: envelopeAddresses(m.envelope?.from),
                        to: envelopeAddresses(m.envelope?.to),
                        subject: m.envelope?.subject ?? '',
                        seen: m.flags?.has('\\Seen') ?? false,
                        flagged: m.flags?.has('\\Flagged') ?? false,
                        size: m.size ?? 0,
                    }))
                    .sort((a, b) => b.uid - a.uid)
                return { total: found.length, messages }
            }),
        size: (folder, uid) =>
            inFolder(folder, async () => {
                const m = await client.fetchOne(
                    String(uid),
                    { uid: true, size: true },
                    { uid: true }
                )
                return m ? (m.size ?? 0) : null
            }),
        source: (folder, uid, markSeen) =>
            inFolder(folder, async () => {
                const m = await client.fetchOne(
                    String(uid),
                    { uid: true, source: true },
                    { uid: true }
                )
                if (!m || !m.source) return null
                if (markSeen) await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true })
                return m.source
            }),
        flags: (folder, uids, seen, flagged) =>
            inFolder(folder, async () => {
                const add: string[] = []
                const remove: string[] = []
                if (seen !== null) (seen ? add : remove).push('\\Seen')
                if (flagged !== null) (flagged ? add : remove).push('\\Flagged')
                if (add.length) await client.messageFlagsAdd(uids, add, { uid: true })
                if (remove.length) await client.messageFlagsRemove(uids, remove, { uid: true })
            }),
        move: (folder, uids, to) =>
            inFolder(folder, async () => {
                const moved = await client.messageMove(uids, to, { uid: true })
                if (!moved) throw new ImapFailure('command', `no se han podido mover a «${to}»`)
            }),
        close: async () => {
            await client.logout().catch(() => client.close())
        },
    }
}

function message(error: unknown): string {
    const e = error as { responseText?: string; message?: string }
    return (e?.responseText ?? e?.message ?? 'error').slice(0, 300)
}

export function imapFailure(error: unknown): ImapFailure {
    const e = error as { authenticationFailed?: boolean; code?: string; message?: string }
    if (e?.authenticationFailed || /auth|login|credentials/i.test(e?.message ?? '')) {
        return new ImapFailure('auth', message(error))
    }
    if (/certificate|self.signed|altname|tls|ssl|starttls/i.test(e?.message ?? '')) {
        return new ImapFailure('tls', message(error))
    }
    if (e?.code && /^E[A-Z]+/.test(e.code)) return new ImapFailure('unreachable', e.code)
    return new ImapFailure('command', message(error))
}

export function createImapHandler(deps: ImapHandlerDeps) {
    const lookup = deps.lookup ?? defaultLookup
    const connect = deps.connect ?? connectImapFlow
    const slots = new ConcurrencyLimit(MAX_CONCURRENT_READS, 'lecturas de correo')

    return async function handleImap(request: Request): Promise<Response> {
        const started = Date.now()
        let agent_id: number | null = null
        let host: string | null = null
        let variants: string[] = []
        let release: (() => void) | null = null
        let session: ImapSession | null = null
        let op: ImapOp | null = null
        try {
            const caller = authenticate(request, deps.registry)
            agent_id = caller.agent_id
            release = slots.acquire(caller.agent_id)
            const req = parseImapRequest(await readJsonObject(request, 64 * 1024))
            op = req.op
            const ref: CredentialRef = {
                agent_id: caller.agent_id,
                conversation_session_id: caller.session,
                credential: req.credential,
            }
            const label = `«${req.credential}»`
            const [imapHost, imapPort, imapUser, imapPassword] = await Promise.all([
                lookupField(deps.resolve, ref, IMAP_LABELS.host),
                lookupField(deps.resolve, ref, IMAP_LABELS.port),
                lookupField(deps.resolve, ref, IMAP_LABELS.user),
                lookupField(deps.resolve, ref, IMAP_LABELS.password),
            ])
            if (imapPassword.status === 'found') variants = collectVariants([imapPassword.value])

            const configured = imapHost.status === 'found' ? normalizeHost(imapHost.value) : null
            if (configured && req.host && req.host !== configured) {
                throw bad(
                    `La credencial ${label} ya dice su servidor (${configured}); no se puede ` +
                        'usar con otro.'
                )
            }
            host = configured ?? req.host
            if (!host) {
                if (imapPassword.status === 'no_destination') {
                    throw noDestinationError(req.credential, null)
                }
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no dice su servidor IMAP. Pásalo con --host ` +
                        '(por ejemplo imap.gmail.com) o pide al operador que añada el campo imap_host.'
                )
            }
            if (/[\s/@?#]/.test(host)) {
                throw bad(`El servidor IMAP de ${label} no es un host válido.`)
            }
            if (imapPassword.status !== 'found') {
                if (imapPassword.status === 'no_destination') {
                    throw noDestinationError(req.credential, host)
                }
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no tiene contraseña. Pide al operador que la añada.`
                )
            }
            assertDestination(req.credential, host, imapPassword.sites)
            const user = imapUser.status === 'found' ? imapUser.value.trim() : ''
            if (!user) {
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no tiene usuario. Pide al operador que lo añada.`
                )
            }
            const port =
                parsePort(imapPort.status === 'found' ? imapPort.value : null, label) ??
                DEFAULT_IMAP_PORT
            const address = await resolvePublicAddress(host, lookup)
            try {
                session = await connect({
                    address: address.address,
                    servername: address.literal ? null : host,
                    port,
                    secure: port === 993,
                    user,
                    password: imapPassword.value,
                })
            } catch (error) {
                throw imapError(error, label, host, port)
            }
            let result: unknown
            try {
                result = await runOp(session, req)
            } catch (error) {
                throw error instanceof KeychainError ? error : imapError(error, label, host, port)
            }
            deps.log('info', 'mail read', { agent_id, host, op, ms: Date.now() - started })
            return Response.json(redactJson({ ok: true, ...(result as object) }, variants))
        } catch (error) {
            if (error instanceof KeychainError) {
                deps.log('warn', 'mail read refused', {
                    agent_id,
                    host,
                    op,
                    code: error.code,
                    status: error.status,
                })
                return errorResponse(
                    new KeychainError(error.code, redactText(error.message, variants), error.status)
                )
            }
            deps.log('error', 'mail read failed', { agent_id, host, op })
            return errorResponse(
                new KeychainError('KEYCHAIN_UNAVAILABLE', 'No se ha podido leer el correo.')
            )
        } finally {
            await session?.close().catch(() => {})
            release?.()
        }
    }
}

async function runOp(session: ImapSession, req: ImapRequest): Promise<unknown> {
    switch (req.op) {
        case 'folders':
            return { folders: await session.folders() }
        case 'search': {
            const found = await session.search(req.folder, req.query, req.limit)
            return { folder: req.folder, total: found.total, messages: found.messages }
        }
        case 'read':
        case 'attachment': {
            const uid = req.uid as number
            const size = await session.size(req.folder, uid)
            if (size === null) throw notFound(req.folder, uid)
            if (size > MAX_MESSAGE_BYTES) {
                throw new KeychainError(
                    'KEYCHAIN_RESPONSE_TOO_LARGE',
                    `El mensaje ${uid} ocupa ${Math.round(size / 1024 / 1024)} MB; como mucho se ` +
                        `leen ${MAX_MESSAGE_BYTES / 1024 / 1024} MB.`
                )
            }
            const source = await session.source(req.folder, uid, req.op === 'read' && req.mark_seen)
            if (!source) throw notFound(req.folder, uid)
            const parsed = await simpleParser(source, {
                skipImageLinks: true,
                skipTextToHtml: true,
            })
            const attachments = parsed.attachments.filter((a) => !a.related || a.filename)
            if (req.op === 'attachment') {
                const a = attachments[(req.index as number) - 1]
                if (!a) {
                    throw new KeychainError(
                        'KEYCHAIN_BAD_REQUEST',
                        `El mensaje ${uid} no tiene el adjunto ${req.index} (tiene ${attachments.length}).`
                    )
                }
                if (a.size > MAX_ATTACHMENT_BYTES) {
                    throw new KeychainError(
                        'KEYCHAIN_RESPONSE_TOO_LARGE',
                        `El adjunto pasa de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`
                    )
                }
                return {
                    filename: a.filename ?? `adjunto-${req.index}`,
                    content_type: a.contentType,
                    size: a.size,
                    content_base64: a.content.toString('base64'),
                }
            }
            let text = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : '')
            const truncated = text.length > MAX_TEXT_CHARS
            if (truncated) text = text.slice(0, MAX_TEXT_CHARS)
            return {
                folder: req.folder,
                uid,
                date: parsed.date?.toISOString() ?? null,
                from: addressText(parsed.from),
                to: addressText(parsed.to),
                cc: addressText(parsed.cc),
                reply_to: addressText(parsed.replyTo),
                subject: parsed.subject ?? '',
                message_id: parsed.messageId ?? null,
                in_reply_to: parsed.inReplyTo ?? null,
                text,
                truncated,
                attachments: attachments.map((a, i) => ({
                    index: i + 1,
                    filename: a.filename ?? `adjunto-${i + 1}`,
                    content_type: a.contentType,
                    size: a.size,
                })),
            }
        }
        case 'mark':
            await session.flags(req.folder, req.uids, req.seen, req.flagged)
            return { folder: req.folder, uids: req.uids }
        case 'move':
            await session.move(req.folder, req.uids, req.to as string)
            return { folder: req.folder, to: req.to, uids: req.uids }
    }
}

function notFound(folder: string, uid: number): KeychainError {
    return new KeychainError(
        'KEYCHAIN_BAD_REQUEST',
        `No hay ningún mensaje ${uid} en «${folder}». Los uid son de cada carpeta: búscalo antes.`,
        404
    )
}

function imapError(error: unknown, label: string, host: string, port: number): KeychainError {
    const failure = error instanceof ImapFailure ? error : imapFailure(error)
    switch (failure.kind) {
        case 'auth':
            return new KeychainError(
                'KEYCHAIN_IMAP_AUTH_FAILED',
                `El servidor ${host} ha rechazado el usuario o la contraseña de ${label} ` +
                    `(${failure.message}). En Gmail hace falta una contraseña de aplicación. ` +
                    'Pide al operador que revise la credencial.'
            )
        case 'tls':
            return new KeychainError(
                'KEYCHAIN_IMAP_FAILED',
                `No se ha podido cifrar la conexión con ${host}:${port} (${failure.message}). ` +
                    'Sin cifrado no se envía la contraseña. Revisa el puerto (993).'
            )
        case 'unreachable':
            return new KeychainError(
                'KEYCHAIN_IMAP_FAILED',
                `No se ha podido conectar con el servidor de correo ${host}:${port} (${failure.message}).`
            )
        case 'command':
            return new KeychainError('KEYCHAIN_IMAP_FAILED', `IMAP: ${failure.message}`)
    }
}
