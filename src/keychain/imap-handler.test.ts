import { describe, expect, test } from 'bun:test'

import type { KeychainResolveAck } from './control-protocol'
import {
    type ImapConnectOptions,
    ImapFailure,
    type ImapSession,
    createImapHandler,
    parseImapRequest,
} from './imap-handler'
import { silentLog } from './log'
import { AgentTokenRegistry } from './registry'

const PASSWORD = 'abcd efgh ijkl mnop'
const SITES = [{ host: 'gmail.com', subdomains: true }]

const RAW = [
    'From: Ana <ana@cliente.com>',
    'To: reservas@vcs.com',
    'Subject: Reserva 12 plazas',
    'Date: Tue, 11 Nov 2026 10:00:00 +0000',
    'Message-ID: <m1@cliente.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Hola, queremos reservar. ${PASSWORD}`,
    '--b',
    'Content-Type: application/pdf; name="bono.pdf"',
    'Content-Disposition: attachment; filename="bono.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 bono').toString('base64'),
    '--b--',
    '',
].join('\r\n')

function setup(fields: Record<string, string> = {}, sites = SITES) {
    const values: Record<string, string> = {
        password: PASSWORD,
        user: 'reservas@vcs.com',
        ...fields,
    }
    const registry = new AgentTokenRegistry()
    registry.set(7, 'tok')
    const connects: ImapConnectOptions[] = []
    const ops: string[] = []
    const session: ImapSession = {
        folders: async () => [{ path: 'INBOX', special_use: '\\Inbox' }],
        search: async (folder, query, limit) => {
            ops.push(`search ${folder} ${JSON.stringify(query)} ${limit}`)
            return {
                total: 1,
                messages: [
                    {
                        uid: 42,
                        date: null,
                        from: 'ana@cliente.com',
                        to: 'reservas@vcs.com',
                        subject: 'Reserva',
                        seen: false,
                        flagged: false,
                        size: 100,
                    },
                ],
            }
        },
        size: async (_f, uid) => (uid === 42 ? RAW.length : null),
        source: async (_f, uid, seen) => {
            ops.push(`source ${uid} ${seen}`)
            return uid === 42 ? Buffer.from(RAW) : null
        },
        flags: async (f, uids, seen, flagged) => {
            ops.push(`flags ${f} ${uids} ${seen} ${flagged}`)
        },
        move: async (f, uids, to) => {
            ops.push(`move ${f} ${uids} ${to}`)
        },
        close: async () => {
            ops.push('close')
        },
    }
    const handle = createImapHandler({
        registry,
        resolve: async ({ field }): Promise<KeychainResolveAck> =>
            field in values
                ? { ok: true, value: values[field] as string, sites }
                : { ok: false, code: 'KEYCHAIN_NO_FIELD', message: 'no' },
        log: silentLog,
        lookup: async () => [{ address: '142.250.1.108', family: 4 }],
        connect: async (o) => {
            connects.push(o)
            if (o.password !== PASSWORD) throw new ImapFailure('auth', 'bad')
            return session
        },
    })
    const call = (body: Record<string, unknown>) =>
        handle(
            new Request('http://keychain:9890/mail/read', {
                method: 'POST',
                headers: { 'X-Kj-Token': 'tok', 'X-Kj-Session': 's' },
                body: JSON.stringify({ credential: 'IMAP reservas', ...body }),
            })
        )
    return { call, connects, ops }
}

describe('parseImapRequest', () => {
    test('defaults and limits', () => {
        const r = parseImapRequest({ credential: 'x', op: 'search', limit: 999 })
        expect(r.folder).toBe('INBOX')
        expect(r.limit).toBe(100)
        expect(() => parseImapRequest({ credential: 'x', op: 'delete' })).toThrow()
        expect(() => parseImapRequest({ credential: 'x', op: 'read' })).toThrow()
        expect(() => parseImapRequest({ credential: 'x', op: 'mark', uids: [1] })).toThrow()
        expect(() => parseImapRequest({ credential: 'x', op: 'folders', password: 'p' })).toThrow()
        expect(() =>
            parseImapRequest({ credential: 'x', op: 'search', query: { since: 'ayer' } })
        ).toThrow()
    })
})

describe('/mail/read', () => {
    test('searches with the host given, over TLS to the address checked', async () => {
        const { call, connects, ops } = setup()
        const response = await call({
            op: 'search',
            host: 'imap.gmail.com',
            query: { unseen: true, from: 'ana' },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { messages: { uid: number }[] }
        expect(body.messages[0]?.uid).toBe(42)
        expect(connects[0]).toMatchObject({
            address: '142.250.1.108',
            servername: 'imap.gmail.com',
            port: 993,
            secure: true,
            user: 'reservas@vcs.com',
        })
        expect(ops).toContain('close')
    })

    test('reads a message: text, attachments listed, password hidden', async () => {
        const { call, ops } = setup({ imap_host: 'imap.gmail.com' })
        const response = await call({ op: 'read', uid: 42, mark_seen: true })
        const body = (await response.json()) as {
            subject: string
            text: string
            attachments: { index: number; filename: string }[]
        }
        expect(body.subject).toBe('Reserva 12 plazas')
        expect(body.text).toContain('queremos reservar')
        expect(body.text).not.toContain(PASSWORD)
        expect(body.attachments).toEqual([
            expect.objectContaining({ index: 1, filename: 'bono.pdf' }),
        ])
        expect(ops).toContain('source 42 true')
    })

    test('downloads an attachment as base64', async () => {
        const { call } = setup({ imap_host: 'imap.gmail.com' })
        const response = await call({ op: 'attachment', uid: 42, index: 1 })
        const body = (await response.json()) as { filename: string; content_base64: string }
        expect(body.filename).toBe('bono.pdf')
        expect(Buffer.from(body.content_base64, 'base64').toString()).toBe('%PDF-1.4 bono')
    })

    test('mark and move, never delete', async () => {
        const { call, ops } = setup({ imap_host: 'imap.gmail.com' })
        await call({ op: 'mark', uids: [1, 2], seen: true })
        await call({ op: 'move', uids: [1], to: 'Procesados' })
        expect(ops).toContain('flags INBOX 1,2 true null')
        expect(ops).toContain('move INBOX 1 Procesados')
    })

    test('the password never goes to a host that is not a destination', async () => {
        const { call, connects } = setup({ imap_host: 'imap.evil.com' })
        const response = await call({ op: 'folders' })
        expect(response.status).toBe(403)
        expect(connects).toHaveLength(0)
    })

    test('a host in the body cannot override the one in the credential', async () => {
        const { call, connects } = setup({ imap_host: 'imap.gmail.com' })
        const response = await call({ op: 'folders', host: 'smtp.gmail.com' })
        expect(response.status).toBe(400)
        expect(connects).toHaveLength(0)
    })

    test('without a host anywhere, says how to give it', async () => {
        const { call } = setup()
        const response = await call({ op: 'folders' })
        const body = (await response.json()) as { error: { code: string; message: string } }
        expect(body.error.code).toBe('KEYCHAIN_NO_FIELD')
        expect(body.error.message).toContain('--host')
    })
})
