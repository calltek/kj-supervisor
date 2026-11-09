/**
 * `POST /mail`: sends a message through the SMTP server of a credential whose
 * password the agent never sees (credenciales-por-referencia.md, «Correo»;
 * the `kj-mail` CLI of kj-agent-base calls this).
 *
 * ```
 * { credential, to: string[], cc?, bcc?, reply_to?, from?, subject, text?, html? }
 * → { ok: true, message_id, accepted, rejected }
 * ```
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
import type { KeychainLog } from './log'
import { type LookupAll, defaultLookup, resolvePublicAddress } from './public-address'
import { collectVariants, redactJson, redactText } from './redact'
import type { AgentTokenRegistry } from './registry'
import type { Resolve } from './resolver'
import { normalizeHost } from './sites'

export const MAIL_PATH = '/mail'

export const MAX_RECIPIENTS = 50
export const MAX_MESSAGE_BYTES = 1024 * 1024
export const MAX_SUBJECT = 998
export const DEFAULT_SMTP_PORT = 587

/** JSON escaping can grow the message; this only stops what is plainly too big. */
const MAX_BODY_BYTES = 4 * 1024 * 1024
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
    if (!BARE_ADDRESS.test(bare) || (named && /[<>]/.test(named[1] ?? ''))) {
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
        message: { to, cc, bcc, reply_to, subject: body.subject, text, html },
    }
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

export function createMailHandler(deps: MailHandlerDeps) {
    const lookup = deps.lookup ?? defaultLookup
    const send = deps.send ?? sendWithNodemailer

    return async function handleMail(request: Request): Promise<Response> {
        const started = Date.now()
        let agent_id: number | null = null
        let host: string | null = null
        let variants: string[] = []
        try {
            const caller = authenticate(request, deps.registry)
            agent_id = caller.agent_id
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
                ms: Date.now() - started,
            })
            return Response.json(redactJson({ ok: true, ...result }, variants))
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
