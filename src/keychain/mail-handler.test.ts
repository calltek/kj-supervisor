import { describe, expect, test } from 'bun:test'

import type { KeychainResolveAck, KeychainSite } from './control-protocol'
import { silentLog } from './log'
import {
    MAIL_PATH,
    MAX_RECIPIENTS,
    SmtpFailure,
    type SmtpSendOptions,
    checkAddress,
    createMailHandler,
    parseMailRequest,
    smtpFailure,
} from './mail-handler'
import { REDACTED } from './redact'
import { AgentTokenRegistry } from './registry'
import type { ResolveRequest } from './resolver'

const TOKEN = 'agent-token-42'
const SESSION = '11111111-2222-4333-8444-555555555555'
const PASSWORD = 'smtp-Pa55word'

function setup(
    fields: Record<string, string>,
    sites: KeychainSite[] = [{ host: 'example.com', subdomains: true }],
    send: (o: SmtpSendOptions) => Promise<unknown> = async (o) => ({
        message_id: '<id@example.com>',
        accepted: o.message.to,
        rejected: [],
    })
) {
    const registry = new AgentTokenRegistry()
    registry.set(42, TOKEN)
    const sent: SmtpSendOptions[] = []
    const handle = createMailHandler({
        registry,
        resolve: async (r: ResolveRequest): Promise<KeychainResolveAck> => {
            const value = fields[r.field]
            if (value === undefined) return { ok: false, code: 'KEYCHAIN_NO_FIELD', message: 'no' }
            if (!sites.length) {
                return { ok: false, code: 'KEYCHAIN_NO_DESTINATION', message: 'none' }
            }
            return { ok: true, value, sites }
        },
        log: silentLog,
        lookup: async (host) =>
            host === 'smtp.example.com'
                ? [{ address: '203.0.114.25', family: 4 }]
                : host === 'smtp.internal.example.com'
                  ? [{ address: '192.168.1.5', family: 4 }]
                  : [],
        send: async (o) => {
            sent.push(o)
            return (await send(o)) as never
        },
    })
    return { handle, sent }
}

const SMTP = { host: 'smtp.example.com', username: 'ventas@example.com', password: PASSWORD }

function post(body: unknown) {
    return new Request(`http://kc:9890${MAIL_PATH}`, {
        method: 'POST',
        headers: { 'x-kj-token': TOKEN, 'x-kj-session': SESSION },
        body: JSON.stringify(body),
    })
}

const MESSAGE = {
    credential: 'Correo',
    to: ['cliente@example.org'],
    subject: 'Hola',
    text: 'Qué tal',
}

async function error(res: Response): Promise<{ code: string; message: string }> {
    return ((await res.json()) as { error: { code: string; message: string } }).error
}

describe('/mail', () => {
    test('sends through the credential server: STARTTLS on 587, from = the username', async () => {
        const { handle, sent } = setup(SMTP)
        const res = await handle(post(MESSAGE))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            message_id: '<id@example.com>',
            accepted: ['cliente@example.org'],
            rejected: [],
        })
        expect(sent[0]).toMatchObject({
            address: '203.0.114.25',
            servername: 'smtp.example.com',
            port: 587,
            secure: false,
            user: 'ventas@example.com',
            password: PASSWORD,
            message: { from: 'ventas@example.com', to: ['cliente@example.org'], subject: 'Hola' },
        })
    })

    test('465 is TLS from the start; a from field wins over the username', async () => {
        const { handle, sent } = setup({
            ...SMTP,
            port: '465',
            from: 'Ventas <no-reply@example.com>',
        })
        expect((await handle(post(MESSAGE))).status).toBe(200)
        expect(sent[0]).toMatchObject({
            port: 465,
            secure: true,
            message: { from: 'Ventas <no-reply@example.com>' },
        })
    })

    test('no destination, or another one: nothing is sent', async () => {
        const none = setup(SMTP, [])
        const e1 = await error(await none.handle(post(MESSAGE)))
        expect(e1.code).toBe('KEYCHAIN_NO_DESTINATION')
        expect(e1.message).toContain('credential_request_destination')
        const other = setup(SMTP, [{ host: 'gmail.com', subdomains: true }])
        expect((await error(await other.handle(post(MESSAGE)))).code).toBe('KEYCHAIN_WRONG_SITE')
        expect(none.sent).toEqual([])
        expect(other.sent).toEqual([])
    })

    test('a private SMTP server is refused', async () => {
        const { handle, sent } = setup({ ...SMTP, host: 'smtp.internal.example.com' })
        expect((await error(await handle(post(MESSAGE)))).code).toBe('KEYCHAIN_PRIVATE_ADDRESS')
        expect(sent).toEqual([])
    })

    test('a server error is relayed with the password hidden', async () => {
        const { handle } = setup(SMTP, undefined, async () => {
            throw new SmtpFailure('auth', `535 bad credentials for ${PASSWORD}`)
        })
        const e = await error(await handle(post(MESSAGE)))
        expect(e.code).toBe('KEYCHAIN_SMTP_AUTH_FAILED')
        expect(e.message).not.toContain(PASSWORD)
        expect(e.message).toContain(REDACTED)
    })
})

describe('/mail: limits', () => {
    test('header injection is impossible', () => {
        expect(() => parseMailRequest({ ...MESSAGE, subject: 'a\r\nBcc: x@y.z' })).toThrow()
        expect(() => parseMailRequest({ ...MESSAGE, to: ['a@b.c\nBcc: x@y.z'] })).toThrow()
        expect(() => parseMailRequest({ ...MESSAGE, reply_to: 'a@b.c\r\n' })).toThrow()
        expect(() => checkAddress('Nombre <a@b.c>', 'to')).not.toThrow()
        expect(() => checkAddress('a@b.c, d@e.f', 'to')).toThrow()
        expect(() => checkAddress('<a@b.c> <d@e.f>', 'to')).toThrow()
    })

    test(`at most ${MAX_RECIPIENTS} recipients in all`, () => {
        const many = Array.from({ length: 30 }, (_, i) => `u${i}@example.org`)
        expect(() => parseMailRequest({ ...MESSAGE, to: many, bcc: many })).toThrow(/50/)
        expect(() => parseMailRequest({ ...MESSAGE, to: many })).not.toThrow()
    })

    test('subject and body sizes', () => {
        expect(() => parseMailRequest({ ...MESSAGE, subject: 'x'.repeat(999) })).toThrow()
        expect(() => parseMailRequest({ ...MESSAGE, text: 'x'.repeat(1024 * 1024 + 1) })).toThrow()
        expect(() => parseMailRequest({ ...MESSAGE, text: undefined })).toThrow()
        expect(() => parseMailRequest({ ...MESSAGE, password: 'x' })).toThrow()
    })

    test('failures from nodemailer by kind', () => {
        expect(smtpFailure({ code: 'EAUTH', response: '535' }).kind).toBe('auth')
        expect(smtpFailure({ code: 'ETLS' }).kind).toBe('tls')
        expect(
            smtpFailure({ code: 'ESOCKET', message: "does not match certificate's altnames" }).kind
        ).toBe('tls')
        expect(smtpFailure({ code: 'EENVELOPE', response: '550 no' }).kind).toBe('rejected')
        expect(smtpFailure({ code: 'ECONNECTION' }).kind).toBe('unreachable')
    })
})
