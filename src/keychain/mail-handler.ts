/**
 * `POST /mail`: sends a message through the SMTP server of a credential whose
 * password the agent never sees (credenciales-por-referencia.md, «Correo»;
 * the `kj-mail` CLI of kj-agent-base calls this).
 *
 * ```
 * { credential, to: string[], cc?, bcc?, reply_to?, from?, subject, text?, html?,
 *   attachments?: [{ filename, content_base64, content_type? }] }
 * → { ok: true, message_id, accepted, rejected, attachments: number }
 * ```
 *
 * Attachments come as bytes, read by `kj-mail` in the conversation's own
 * process — so only a file that conversation can read — and never as a path:
 * this container has no files of the agent's, and nodemailer's file and URL
 * access stay off. `kj-mail` sends them to `/mail/attach`, which an older
 * kj-keychain doesn't know (nothing goes out) instead of `/mail`, where it
 * would drop the attachments and send the rest.
 *
 * Host, port, user, password and `from` come from the credential; the body
 * may only pick another `from` (the server decides whether it lets it). Port
 * 465 is TLS from the start; any other must offer STARTTLS, which is
 * required before authenticating: the password never goes in clear. The host
 * must be one of the credential's destinations and a public address, and the
 * connection goes to the address checked, with the certificate verified
 * against the name.
 */

import nodemailer from 'nodemailer'

import { authenticate, credentialName, readJsonObject } from './agent-request'
import {
    type CredentialRef,
    FIELD_LABELS,
    assertDestination,
    lookupField,
    noDestinationError,
    parsePort,
} from './credential-fields'
import { KeychainError, errorResponse } from './errors'
import { ConcurrencyLimit, WindowQuota } from './limits'
import type { KeychainLog } from './log'
import { type LookupAll, defaultLookup, resolvePublicAddress } from './public-address'
import { collectVariants, redactJson, redactText } from './redact'
import type { AgentTokenRegistry } from './registry'
import type { Resolve } from './resolver'
import { normalizeHost } from './sites'

export const MAIL_PATH = '/mail'
/** Same handler; the path `kj-mail` uses when it attaches (see above). */
export const MAIL_ATTACH_PATH = '/mail/attach'

export const MAX_RECIPIENTS = 50
export const MAX_MESSAGE_BYTES = 1024 * 1024
export const MAX_SUBJECT = 998
export const DEFAULT_SMTP_PORT = 587
/** What most mail servers take whole (they refuse past 20–25 MB, base64 included). */
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_FILENAME = 255

/** The message plus its attachments in base64 and JSON escaping, with room. */
const MAX_BODY_BYTES = 4 * 1024 * 1024 + Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3)
const MAX_ADDRESS = 320

export interface SmtpSendOptions {
    /** The address checked (never re-resolved). */
    address: string
    /** The name, for SNI and the certificate; null when the host is an IP. */
    servername: string | null
    port: number
    /** TLS from the first byte (465); otherwise STARTTLS, required. */
    secure: boolean
    user: string
    password: string
    message: MailMessage
}

export interface MailMessage {
    from: string
    to: string[]
    cc: string[]
    bcc: string[]
    reply_to: string | null
    subject: string
    text: string | null
    html: string | null
    attachments: MailAttachment[]
}

export interface MailAttachment {
    filename: string
    content: Buffer
    content_type: string
    /**
     * Content-ID of an image shown inside the HTML (`<img src="cid:logo">`),
     * so Outlook and Gmail show it without «show images». Only a name.
     */
    cid?: string
}

export interface SmtpSendResult {
    message_id: string
    accepted: string[]
    rejected: string[]
}

export type SendMail = (options: SmtpSendOptions) => Promise<SmtpSendResult>

/** A failure from the SMTP server, by kind, for the message the agent relays. */
export class SmtpFailure extends Error {
    constructor(
        readonly kind: 'auth' | 'tls' | 'unreachable' | 'rejected',
        message: string
    ) {
        super(message)
    }
}

export interface MailHandlerDeps {
    registry: AgentTokenRegistry
    resolve: Resolve
    log: KeychainLog
    lookup?: LookupAll
    send?: SendMail
    quota?: WindowQuota
}

function bad(message: string): KeychainError {
    return new KeychainError('KEYCHAIN_BAD_REQUEST', message)
}

const BARE_ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
const CONTROL = /[\u0000-\u001f\u007f]/

/** `a@b.c` or `Nombre <a@b.c>`; never a line break (no header injection). */
export function checkAddress(value: unknown, what: string): string {
    if (typeof value !== 'string') throw bad(`${what} tiene que ser una dirección de correo.`)
    if (CONTROL.test(value)) {
        throw bad(`${what} lleva saltos de línea o caracteres de control; no se envía.`)
    }
    const text = value.trim()
    if (!text || text.length > MAX_ADDRESS) throw bad(`${what} no es una dirección válida.`)
    const named = /^(.*)<([^<>]+)>$/.exec(text)
    const bare = named ? (named[2] ?? '').trim() : text
    // No , ; " \ in the name either: nodemailer would split `a@x, B <b@y>` in two.
    if (!BARE_ADDRESS.test(bare) || (named && /[<>,;"\\]/.test(named[1] ?? ''))) {
        throw bad(`${what} no es una dirección válida: ${text}`)
    }
    return text
}

function addressList(value: unknown, what: string, required: boolean): string[] {
    if (value === undefined || value === null) {
        if (required) throw bad(`Falta ${what}.`)
        return []
    }
    if (!Array.isArray(value)) throw bad(`${what} tiene que ser una lista de direcciones.`)
    if (required && value.length === 0) throw bad(`Falta ${what}.`)
    return value.map((v) => checkAddress(v, what))
}

/** The bare address of `a@b.c` or `Nombre <a@b.c>`, lower-cased. */
function bareAddress(value: string): string {
    const named = /<([^<>]+)>$/.exec(value.trim())
    return (named ? (named[1] ?? '') : value).trim().toLowerCase()
}

/**
 * Whether `address` is let in by one of the credential's recipients: the same
 * address, or `*@domain` for exactly that domain (never a subdomain), as a
 * mail channel's recipient list reads it (kj-backend `sender-filter.ts`).
 */
export function recipientAllowed(address: string, allowed: readonly string[]): boolean {
    const addr = bareAddress(address)
    return allowed.some((entry) => {
        const want = entry.trim().toLowerCase()
        if (want.startsWith('*@')) return addr.endsWith(want.slice(1))
        return want === addr
    })
}

/**
 * Every to, cc and bcc has to be one the credential allows, or nothing is sent.
 * No list = anyone: a credential without recipients, or a backend that does not
 * send them yet.
 */
export function assertRecipients(
    credential: string,
    addresses: readonly string[],
    allowed: readonly string[] | undefined
): void {
    if (!allowed?.length) return
    const out = addresses.filter((a) => !recipientAllowed(a, allowed))
    if (out.length === 0) return
    throw new KeychainError(
        'KEYCHAIN_WRONG_RECIPIENT',
        `La credencial «${credential}» sólo puede escribir a ${allowed.join(', ')}; no a ` +
            `${out.map(bareAddress).join(', ')}. No se ha enviado nada. Si hace falta, quien ` +
            'gestione la credencial puede añadirlo en Credenciales.'
    )
}

export interface MailRequest {
    credential: string
    from: string | null
    message: Omit<MailMessage, 'from'>
}

export function parseMailRequest(body: Record<string, unknown>): MailRequest {
    if ('password' in body) {
        throw bad('La contraseña nunca va en la petición: la pone Kujira desde la credencial.')
    }
    const credential = credentialName(body.credential)
    const to = addressList(body.to, 'to', true)
    const cc = addressList(body.cc, 'cc', false)
    const bcc = addressList(body.bcc, 'bcc', false)
    if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
        throw bad(`Como mucho ${MAX_RECIPIENTS} destinatarios por envío, sumando to, cc y bcc.`)
    }
    const reply_to =
        body.reply_to === undefined || body.reply_to === null
            ? null
            : checkAddress(body.reply_to, 'reply_to')
    const from =
        body.from === undefined || body.from === null ? null : checkAddress(body.from, 'from')
    if (typeof body.subject !== 'string') throw bad('Falta el asunto (subject).')
    if (CONTROL.test(body.subject)) {
        throw bad('El asunto lleva saltos de línea o caracteres de control; no se envía.')
    }
    if (body.subject.length > MAX_SUBJECT) {
        throw bad(`El asunto pasa de ${MAX_SUBJECT} caracteres.`)
    }
    const text = body.text === undefined || body.text === null ? null : body.text
    const html = body.html === undefined || body.html === null ? null : body.html
    if (
        (text !== null && typeof text !== 'string') ||
        (html !== null && typeof html !== 'string')
    ) {
        throw bad('text y html son texto.')
    }
    if (!text && !html) throw bad('Falta el cuerpo del mensaje (text o html).')
    const size = Buffer.byteLength(text ?? '', 'utf8') + Buffer.byteLength(html ?? '', 'utf8')
    if (size > MAX_MESSAGE_BYTES) {
        throw new KeychainError(
            'KEYCHAIN_REQUEST_TOO_LARGE',
            'El cuerpo del mensaje pasa de 1 MB, el máximo para enviar con una credencial.'
        )
    }
    return {
        credential,
        from,
        message: {
            to,
            cc,
            bcc,
            reply_to,
            subject: body.subject,
            text,
            html,
            attachments: parseAttachments(body.attachments),
        },
    }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const CID = /^[A-Za-z0-9._@-]{1,100}$/
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

/**
 * The attachments as bytes. A name is only a name — never a path, a line break
 * or a header — and a type that doesn't read as one becomes a plain download.
 */
export function parseAttachments(value: unknown): MailAttachment[] {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) throw bad('attachments tiene que ser una lista.')
    if (value.length > MAX_ATTACHMENTS) {
        throw bad(`Como mucho ${MAX_ATTACHMENTS} adjuntos por correo.`)
    }
    let total = 0
    return value.map((raw, i) => {
        const what = `El adjunto ${i + 1}`
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw bad(`${what} no tiene la forma { filename, content_base64 }.`)
        }
        const a = raw as Record<string, unknown>
        if (typeof a.filename !== 'string' || !a.filename.trim()) {
            throw bad(`${what} no tiene nombre.`)
        }
        const filename = a.filename.trim()
        if (CONTROL.test(filename) || /[/\\]/.test(filename) || filename.length > MAX_FILENAME) {
            throw bad(`${what} tiene un nombre no válido: sólo el nombre, sin carpetas.`)
        }
        if (typeof a.content_base64 !== 'string' || !BASE64.test(a.content_base64)) {
            throw bad(`${what} (${filename}) no viene en base64.`)
        }
        const content = Buffer.from(a.content_base64, 'base64')
        total += content.byteLength
        if (total > MAX_ATTACHMENT_BYTES) {
            throw new KeychainError(
                'KEYCHAIN_REQUEST_TOO_LARGE',
                `Los adjuntos pasan de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB en total, el ` +
                    'máximo para enviar con una credencial. Comprime los ficheros o compártelos ' +
                    'con un enlace.'
            )
        }
        const content_type =
            typeof a.content_type === 'string' && CONTENT_TYPE.test(a.content_type)
                ? a.content_type.toLowerCase()
                : 'application/octet-stream'
        let cid: string | undefined
        if (a.cid !== undefined && a.cid !== null) {
            if (typeof a.cid !== 'string' || !CID.test(a.cid)) {
                throw bad(
                    `${what} (${filename}) tiene un cid no válido: letras, números, punto, guion, guion bajo o @, hasta 100.`
                )
            }
            cid = a.cid
        }
        return { filename, content, content_type, ...(cid ? { cid } : {}) }
    })
}

function isEmail(value: string): boolean {
    return BARE_ADDRESS.test(value) && !CONTROL.test(value)
}

export const sendWithNodemailer: SendMail = async (o) => {
    const transport = nodemailer.createTransport({
        host: o.address,
        port: o.port,
        secure: o.secure,
        requireTLS: !o.secure,
        ...(o.servername ? { servername: o.servername } : {}),
        tls: {
            ...(o.servername ? { servername: o.servername } : {}),
            minVersion: 'TLSv1.2',
            rejectUnauthorized: true,
        },
        auth: { user: o.user, pass: o.password },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        disableFileAccess: true,
        disableUrlAccess: true,
    })
    try {
        const m = o.message
        const info = await transport.sendMail({
            from: m.from,
            to: m.to,
            cc: m.cc.length ? m.cc : undefined,
            bcc: m.bcc.length ? m.bcc : undefined,
            replyTo: m.reply_to ?? undefined,
            subject: m.subject,
            text: m.text ?? undefined,
            html: m.html ?? undefined,
            attachments: m.attachments.length
                ? m.attachments.map((a) => ({
                      filename: a.filename,
                      content: a.content,
                      contentType: a.content_type,
                      ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' as const } : {}),
                  }))
                : undefined,
            disableFileAccess: true,
            disableUrlAccess: true,
        })
        const asText = (list: unknown): string[] =>
            Array.isArray(list)
                ? list.map((a) =>
                      typeof a === 'string' ? a : String((a as { address?: string })?.address)
                  )
                : []
        return {
            message_id: String(info.messageId ?? ''),
            accepted: asText(info.accepted),
            rejected: asText(info.rejected),
        }
    } catch (error) {
        throw smtpFailure(error)
    } finally {
        transport.close()
    }
}

export function smtpFailure(error: unknown): SmtpFailure {
    const e = error as { code?: string; response?: string; responseCode?: number; message?: string }
    const detail = e?.response ?? e?.message ?? 'error'
    switch (e?.code) {
        case 'EAUTH':
            return new SmtpFailure('auth', detail)
        case 'ETLS':
            return new SmtpFailure('tls', detail)
        case 'EENVELOPE':
        case 'EMESSAGE':
            return new SmtpFailure('rejected', detail)
    }
    if (typeof e?.responseCode === 'number' && e.responseCode >= 500) {
        return new SmtpFailure('rejected', detail)
    }
    if (/certificate|self.signed|altname|tls|ssl/i.test(e?.message ?? '')) {
        return new SmtpFailure('tls', e?.message ?? 'TLS')
    }
    return new SmtpFailure('unreachable', e?.code ?? detail)
}

/** Mail sends of one agent at once, and recipients per agent per hour. */
export const MAX_CONCURRENT_SENDS = 4
export const MAX_RECIPIENTS_PER_HOUR = 500

export function createMailHandler(deps: MailHandlerDeps) {
    const lookup = deps.lookup ?? defaultLookup
    const send = deps.send ?? sendWithNodemailer
    const slots = new ConcurrencyLimit(MAX_CONCURRENT_SENDS, 'envíos')
    const quota = deps.quota ?? new WindowQuota(MAX_RECIPIENTS_PER_HOUR, 60 * 60 * 1000)

    return async function handleMail(request: Request): Promise<Response> {
        const started = Date.now()
        let agent_id: number | null = null
        let host: string | null = null
        let variants: string[] = []
        let release: (() => void) | null = null
        try {
            const caller = authenticate(request, deps.registry)
            agent_id = caller.agent_id
            release = slots.acquire(caller.agent_id)
            const req = parseMailRequest(await readJsonObject(request, MAX_BODY_BYTES))
            const ref: CredentialRef = {
                agent_id: caller.agent_id,
                conversation_session_id: caller.session,
                credential: req.credential,
            }
            const label = `«${req.credential}»`
            const [smtpHost, smtpPort, smtpUser, smtpPassword, credFrom] = await Promise.all([
                lookupField(deps.resolve, ref, FIELD_LABELS.smtp_host),
                lookupField(deps.resolve, ref, FIELD_LABELS.smtp_port),
                lookupField(deps.resolve, ref, FIELD_LABELS.smtp_user),
                lookupField(deps.resolve, ref, FIELD_LABELS.smtp_password),
                lookupField(deps.resolve, ref, FIELD_LABELS.from),
            ])
            if (smtpPassword.status === 'found') variants = collectVariants([smtpPassword.value])

            if (smtpHost.status === 'no_destination') throw noDestinationError(req.credential, null)
            if (smtpHost.status === 'absent') {
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no tiene el servidor SMTP (campo host). Pide al ` +
                        'operador que lo añada en Credenciales.'
                )
            }
            host = normalizeHost(smtpHost.value)
            if (!host || /[\s/@?#]/.test(host)) {
                throw new KeychainError(
                    'KEYCHAIN_BAD_REQUEST',
                    `El servidor SMTP de ${label} no es un host válido.`
                )
            }
            if (smtpPassword.status !== 'found') {
                if (smtpPassword.status === 'no_destination') {
                    throw noDestinationError(req.credential, host)
                }
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no tiene contraseña. Pide al operador que la añada ` +
                        'en Credenciales.'
                )
            }
            // 1. The password only goes to a destination of its credential.
            assertDestination(req.credential, host, smtpPassword.sites)
            // 2. And the mail only to the recipients it allows, if it lists any.
            assertRecipients(
                req.credential,
                [...req.message.to, ...req.message.cc, ...req.message.bcc],
                smtpPassword.recipients
            )
            const user = smtpUser.status === 'found' ? smtpUser.value.trim() : ''
            if (!user) {
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no tiene usuario. Pide al operador que lo añada en ` +
                        'Credenciales.'
                )
            }
            const configuredFrom = credFrom.status === 'found' ? credFrom.value.trim() : ''
            const from =
                req.from ??
                (configuredFrom
                    ? checkAddress(configuredFrom, `El remitente de ${label}`)
                    : null) ??
                (isEmail(user) ? user : null)
            if (!from) {
                throw new KeychainError(
                    'KEYCHAIN_NO_FIELD',
                    `La credencial ${label} no dice desde qué dirección se envía. Pásala en from.`
                )
            }
            const port =
                parsePort(smtpPort.status === 'found' ? smtpPort.value : null, label) ??
                DEFAULT_SMTP_PORT

            // 2. A public address, and the connection goes to the one checked.
            const address = await resolvePublicAddress(host, lookup)
            const recipients =
                req.message.to.length + req.message.cc.length + req.message.bcc.length
            quota.take(
                caller.agent_id,
                recipients,
                () =>
                    new KeychainError(
                        'KEYCHAIN_RATE_LIMITED',
                        `Este agente ya ha enviado a ${MAX_RECIPIENTS_PER_HOUR} destinatarios en ` +
                            'la última hora, el máximo con una credencial. Espera o díselo al ' +
                            'operador.'
                    )
            )

            let result: SmtpSendResult
            try {
                result = await send({
                    address: address.address,
                    servername: address.literal ? null : host,
                    port,
                    secure: port === 465,
                    user,
                    password: smtpPassword.value,
                    message: { from, ...req.message },
                })
            } catch (error) {
                throw mailError(error, label, host, port)
            }
            deps.log('info', 'mail', {
                agent_id,
                host,
                recipients: req.message.to.length + req.message.cc.length + req.message.bcc.length,
                accepted: result.accepted.length,
                rejected: result.rejected.length,
                // How many and how big; never their names or contents.
                attachments: req.message.attachments.length,
                attachment_bytes: req.message.attachments.reduce(
                    (n, a) => n + a.content.byteLength,
                    0
                ),
                ms: Date.now() - started,
            })
            return Response.json(
                redactJson(
                    { ok: true, ...result, attachments: req.message.attachments.length },
                    variants
                )
            )
        } catch (error) {
            if (error instanceof KeychainError) {
                deps.log('warn', 'mail refused', {
                    agent_id,
                    host,
                    code: error.code,
                    status: error.status,
                })
                return errorResponse(
                    new KeychainError(error.code, redactText(error.message, variants), error.status)
                )
            }
            deps.log('error', 'mail failed', { agent_id, host })
            return errorResponse(
                new KeychainError(
                    'KEYCHAIN_UNAVAILABLE',
                    'No se ha podido enviar el correo con la credencial.'
                )
            )
        } finally {
            release?.()
        }
    }
}

function mailError(error: unknown, label: string, host: string, port: number): KeychainError {
    const failure = error instanceof SmtpFailure ? error : smtpFailure(error)
    switch (failure.kind) {
        case 'auth':
            return new KeychainError(
                'KEYCHAIN_SMTP_AUTH_FAILED',
                `El servidor ${host} ha rechazado el usuario o la contraseña de ${label} ` +
                    `(${failure.message}). Pide al operador que revise la credencial.`
            )
        case 'tls':
            return new KeychainError(
                'KEYCHAIN_SMTP_FAILED',
                `No se ha podido cifrar la conexión con ${host}:${port} (${failure.message}). ` +
                    'Sin cifrado no se envía la contraseña. Revisa el puerto (465 o 587).'
            )
        case 'rejected':
            return new KeychainError(
                'KEYCHAIN_MAIL_REJECTED',
                `El servidor ${host} no ha aceptado el mensaje: ${failure.message}`
            )
        case 'unreachable':
            return new KeychainError(
                'KEYCHAIN_SMTP_FAILED',
                `No se ha podido conectar con el servidor de correo ${host}:${port} ` +
                    `(${failure.message}).`
            )
    }
}
