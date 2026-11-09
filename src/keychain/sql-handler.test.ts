import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'

import type { KeychainResolveAck, KeychainSite } from './control-protocol'
import { lookupField } from './credential-fields'
import { silentLog } from './log'
import { REDACTED, redactJson } from './redact'
import { AgentTokenRegistry } from './registry'
import type { ResolveRequest } from './resolver'
import {
    MAX_ROWS_CAP,
    SQL_PATH,
    chooseEngine,
    createSqlHandler,
    parseSqlRequest,
} from './sql-handler'
import { type SqlRunOptions, SqlFailure } from './sql-engines'
import { KnownHosts, type SshTunnelOptions, innerSignature } from './ssh-tunnel'
import { sshString } from './ssh-keys'

const TOKEN = 'agent-token-42'
const SESSION = '11111111-2222-4333-8444-555555555555'
const PASSWORD = 's3cr3t-Pa55'
const PEM = generateKeyPairSync('ed25519').privateKey.export({
    format: 'pem',
    type: 'pkcs8',
}) as string

interface FakeCredential {
    fields: Record<string, string>
    sites: KeychainSite[]
}

/** The backend as kj-keychain sees it: by label, and no destination = only the SSH key. */
function fakeResolve(credentials: Record<string, FakeCredential>) {
    const calls: ResolveRequest[] = []
    const resolve = async (r: ResolveRequest): Promise<KeychainResolveAck> => {
        calls.push(r)
        const cred = credentials[r.credential]
        if (!cred) return { ok: false, code: 'KEYCHAIN_NOT_FOUND', message: 'not assigned' }
        const value = cred.fields[r.field]
        if (value === undefined) return { ok: false, code: 'KEYCHAIN_NO_FIELD', message: 'no' }
        if (!cred.sites.length && r.field !== 'ssh_private_key') {
            return { ok: false, code: 'KEYCHAIN_NO_DESTINATION', message: 'no destination' }
        }
        return { ok: true, value, sites: cred.sites }
    }
    return { resolve, calls }
}

const DNS: Record<string, string> = {
    'db.example.com': '203.0.114.10',
    'bastion.example.com': '198.51.101.20',
    'internal.example.com': '10.0.0.5',
}

function setup(
    credentials: Record<string, FakeCredential>,
    run: (o: SqlRunOptions) => Promise<unknown> = async () => ({
        columns: ['id', 'name'],
        rows: [[1, 'uno']],
        row_count: 1,
        truncated: false,
    })
) {
    const registry = new AgentTokenRegistry()
    registry.set(42, TOKEN)
    const { resolve, calls } = fakeResolve(credentials)
    const runs: SqlRunOptions[] = []
    const tunnels: SshTunnelOptions[] = []
    let closed = 0
    const handle = createSqlHandler({
        registry,
        resolve,
        log: silentLog,
        lookup: async (host) => {
            const address = DNS[host]
            return address ? [{ address, family: 4 }] : []
        },
        openTunnel: async (options) => {
            tunnels.push(options)
            return {
                stream: {} as never,
                close: () => {
                    closed += 1
                },
            }
        },
        runSql: async (options) => {
            runs.push(options)
            return (await run(options)) as never
        },
    })
    return { handle, calls, runs, tunnels, closed: () => closed }
}

function post(body: unknown, token = TOKEN) {
    return new Request(`http://kc:9890${SQL_PATH}`, {
        method: 'POST',
        headers: { 'x-kj-token': token, 'x-kj-session': SESSION },
        body: JSON.stringify(body),
    })
}

async function error(res: Response): Promise<{ code: string; message: string }> {
    return ((await res.json()) as { error: { code: string; message: string } }).error
}

const PROD_DB: FakeCredential = {
    fields: {
        host: '127.0.0.1',
        port: '3306',
        username: 'app',
        password: PASSWORD,
        database: 'shop',
    },
    sites: [{ host: 'bastion.example.com', subdomains: false }],
}
const BASTION: FakeCredential = {
    fields: { ssh_private_key: PEM, host: 'bastion.example.com', username: 'deploy' },
    sites: [],
}
const DIRECT_DB: FakeCredential = {
    fields: { host: 'db.example.com', user: 'reader', password: PASSWORD },
    sites: [{ host: 'example.com', subdomains: true }],
}

describe('/sql: the request', () => {
    test('the password never comes from the body', () => {
        expect(() => parseSqlRequest({ credential: 'DB', sql: 'select 1', password: 'x' })).toThrow(
            /nunca va en la petición/
        )
    })

    test('engine: postgres on 5432, mysql (and MariaDB) otherwise', () => {
        expect(chooseEngine(null, 5432)).toBe('postgres')
        expect(chooseEngine(null, 3306)).toBe('mysql')
        expect(chooseEngine(null, null)).toBe('mysql')
        expect(chooseEngine('postgres', 3306)).toBe('postgres')
    })

    test('max_rows defaults to 1000 and is capped', () => {
        expect(parseSqlRequest({ credential: 'DB', sql: 'x' }).max_rows).toBe(1000)
        expect(parseSqlRequest({ credential: 'DB', sql: 'x', max_rows: 99_999 }).max_rows).toBe(
            MAX_ROWS_CAP
        )
        expect(() => parseSqlRequest({ credential: 'DB', sql: 'x', max_rows: 0 })).toThrow()
    })

    test('params are scalars only', () => {
        expect(() => parseSqlRequest({ credential: 'DB', sql: 'x', params: [{ a: 1 }] })).toThrow()
        expect(
            parseSqlRequest({ credential: 'DB', sql: 'x', params: ['a', 1, true, null] }).params
        ).toEqual(['a', 1, true, null])
    })
})

describe('/sql: fields of the credential', () => {
    test('the first label that exists wins; a missing one is absent', async () => {
        const { resolve } = fakeResolve({
            DB: {
                fields: { db_host: 'a', hostname: 'b' },
                sites: [{ host: 'a', subdomains: false }],
            },
        })
        const ref = { agent_id: 42, conversation_session_id: SESSION, credential: 'DB' }
        expect(await lookupField(resolve, ref, ['host', 'hostname', 'db_host'])).toMatchObject({
            status: 'found',
            value: 'b',
        })
        expect(await lookupField(resolve, ref, ['port'])).toEqual({ status: 'absent' })
    })

    test('another error from the backend stops the request', async () => {
        const { resolve } = fakeResolve({})
        const ref = { agent_id: 42, conversation_session_id: SESSION, credential: 'Nope' }
        expect(lookupField(resolve, ref, ['host'])).rejects.toMatchObject({
            code: 'KEYCHAIN_NOT_FOUND',
        })
    })
})

describe('/sql: direct connection', () => {
    test('connects to the checked address with the credential fields', async () => {
        const { handle, runs, tunnels } = setup({ 'DB - Ventas': DIRECT_DB })
        const res = await handle(post({ credential: 'DB - Ventas', sql: 'select id, name from t' }))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            columns: ['id', 'name'],
            rows: [[1, 'uno']],
            row_count: 1,
            truncated: false,
        })
        expect(tunnels).toEqual([])
        expect(runs[0]).toMatchObject({
            engine: 'mysql',
            transport: {
                kind: 'tls',
                address: '203.0.114.10',
                port: 3306,
                servername: 'db.example.com',
            },
            user: 'reader',
            password: PASSWORD,
            database: null,
            max_rows: 1000,
            connect_timeout_ms: 15_000,
            statement_timeout_ms: 60_000,
        })
    })

    test('the body overrides non-secret fields; port 5432 picks postgres', async () => {
        const { handle, runs } = setup({ DB: DIRECT_DB })
        const res = await handle(
            post({ credential: 'DB', sql: 'x', port: 5432, user: 'admin', database: 'ops' })
        )
        expect(res.status).toBe(200)
        expect(runs[0]).toMatchObject({
            engine: 'postgres',
            transport: { port: 5432 },
            user: 'admin',
            database: 'ops',
        })
    })

    test('a private address is refused before connecting', async () => {
        const { handle, runs } = setup({
            DB: { ...DIRECT_DB, fields: { ...DIRECT_DB.fields, host: 'internal.example.com' } },
        })
        const res = await handle(post({ credential: 'DB', sql: 'x' }))
        expect((await error(res)).code).toBe('KEYCHAIN_PRIVATE_ADDRESS')
        expect(runs).toEqual([])
    })

    test('a host that is not a destination of the credential', async () => {
        const { handle, runs } = setup({
            DB: { ...DIRECT_DB, sites: [{ host: 'other.com', subdomains: true }] },
        })
        const res = await handle(post({ credential: 'DB', sql: 'x' }))
        const e = await error(res)
        expect(e.code).toBe('KEYCHAIN_WRONG_SITE')
        expect(e.message).toContain('db.example.com')
        expect(e.message).toContain('credential_request_destination')
        expect(runs).toEqual([])
    })

    test('no destination: ask for one, naming the host', async () => {
        const { handle, runs } = setup({ DB: { ...DIRECT_DB, sites: [] } })
        const res = await handle(post({ credential: 'DB', sql: 'x', host: 'db.example.com' }))
        const e = await error(res)
        expect(e.code).toBe('KEYCHAIN_NO_DESTINATION')
        expect(e.message).toContain('credential_request_destination')
        expect(e.message).toContain('db.example.com')
        expect(runs).toEqual([])
    })

    test('without a password field there is nothing to use', async () => {
        const { handle } = setup({
            DB: { ...DIRECT_DB, fields: { host: 'db.example.com', user: 'reader' } },
        })
        expect((await error(await handle(post({ credential: 'DB', sql: 'x' })))).code).toBe(
            'KEYCHAIN_NO_FIELD'
        )
    })

    test('without a valid agent token', async () => {
        const { handle } = setup({ DB: DIRECT_DB })
        const res = await handle(post({ credential: 'DB', sql: 'x' }, 'wrong'))
        expect(res.status).toBe(401)
    })
})

/** `ssh -L 3307:127.0.0.1:3306 deploy@bastion.example.com`, as the agent would ask. */
const VIA_BASTION = {
    credential: 'DB prod',
    ssh: { credential: 'Bastion', host: 'bastion.example.com', user: 'deploy' },
    sql: 'select 1',
}

describe('/sql: through an SSH tunnel', () => {
    test('kj-keychain opens the tunnel; the database host is relative to it', async () => {
        const { handle, runs, tunnels, closed } = setup({ 'DB prod': PROD_DB, Bastion: BASTION })
        const res = await handle(post(VIA_BASTION))
        expect(res.status).toBe(200)
        expect(tunnels).toHaveLength(1)
        expect(tunnels[0]).toMatchObject({
            address: '198.51.101.20',
            port: 22,
            username: 'deploy',
            dst_host: '127.0.0.1',
            dst_port: 3306,
        })
        expect(runs[0]?.transport).toMatchObject({ kind: 'tunnel', host: '127.0.0.1', port: 3306 })
        expect(runs[0]?.database).toBe('shop')
        expect(closed()).toBe(1)
    })

    test('host and user come from the SSH credential when it has destinations', async () => {
        const { handle, tunnels } = setup({
            'DB prod': PROD_DB,
            Bastion: { ...BASTION, sites: [{ host: 'bastion.example.com', subdomains: false }] },
        })
        const res = await handle(
            post({ credential: 'DB prod', ssh: { credential: 'Bastion' }, sql: 'select 1' })
        )
        expect(res.status).toBe(200)
        expect(tunnels[0]).toMatchObject({ address: '198.51.101.20', username: 'deploy' })
    })

    test('an SSH credential without destinations does not give its host: say where', async () => {
        const { handle, tunnels } = setup({ 'DB prod': PROD_DB, Bastion: BASTION })
        const res = await handle(
            post({ credential: 'DB prod', ssh: { credential: 'Bastion' }, sql: 'select 1' })
        )
        const e = await error(res)
        expect(e.code).toBe('KEYCHAIN_NO_FIELD')
        expect(e.message).toContain('ssh.host')
        expect(tunnels).toEqual([])
    })

    test('the first hop is the SSH server: it must be a destination of the DB credential', async () => {
        const { handle, tunnels, runs } = setup({
            'DB prod': { ...PROD_DB, sites: [{ host: '127.0.0.1', subdomains: false }] },
            Bastion: BASTION,
        })
        const res = await handle(post(VIA_BASTION))
        const e = await error(res)
        expect(e.code).toBe('KEYCHAIN_WRONG_SITE')
        expect(e.message).toContain('bastion.example.com')
        expect(tunnels).toEqual([])
        expect(runs).toEqual([])
    })

    test('the SSH server itself must be public', async () => {
        const { handle, tunnels } = setup({
            'DB prod': { ...PROD_DB, sites: [{ host: 'internal.example.com', subdomains: false }] },
            Bastion: BASTION,
        })
        const res = await handle(
            post({ ...VIA_BASTION, ssh: { ...VIA_BASTION.ssh, host: 'internal.example.com' } })
        )
        expect((await error(res)).code).toBe('KEYCHAIN_PRIVATE_ADDRESS')
        expect(tunnels).toEqual([])
    })

    test('an SSH credential without a key', async () => {
        const { handle } = setup({
            'DB prod': PROD_DB,
            Bastion: { ...BASTION, fields: { username: 'x' } },
        })
        expect((await error(await handle(post(VIA_BASTION)))).code).toBe('KEYCHAIN_NO_FIELD')
    })

    test('the tunnel is closed also when the query fails', async () => {
        const { handle, closed } = setup({ 'DB prod': PROD_DB, Bastion: BASTION }, async () => {
            throw new SqlFailure('timeout', 'x')
        })
        const e = await error(await handle(post(VIA_BASTION)))
        expect(e.code).toBe('KEYCHAIN_DB_TIMEOUT')
        expect(closed()).toBe(1)
    })
})

describe('/sql: the password never comes back', () => {
    test('masked in rows, column names and numbers', async () => {
        const numeric = '987654'
        const { handle } = setup(
            { DB: { ...DIRECT_DB, fields: { ...DIRECT_DB.fields, password: numeric } } },
            async () => ({
                columns: ['id', `col_${numeric}`],
                rows: [[987654, `x ${numeric} y`, Buffer.from(numeric).toString('base64')]],
                row_count: 1,
                truncated: false,
            })
        )
        const res = await handle(post({ credential: 'DB', sql: 'select' }))
        const text = await res.text()
        expect(text).not.toContain(numeric)
        expect(text).not.toContain(Buffer.from(numeric).toString('base64'))
        expect(JSON.parse(text).rows[0][0]).toBe(REDACTED)
    })

    test('masked in error messages', async () => {
        const { handle } = setup({ DB: DIRECT_DB }, async () => {
            throw new SqlFailure('sql', `syntax error near '${PASSWORD}'`)
        })
        const res = await handle(post({ credential: 'DB', sql: 'select' }))
        const e = await error(res)
        expect(e.code).toBe('KEYCHAIN_SQL_ERROR')
        expect(e.message).not.toContain(PASSWORD)
        expect(e.message).toContain(REDACTED)
    })

    test('an authentication failure says so, masked', async () => {
        const { handle } = setup({ DB: DIRECT_DB }, async () => {
            throw new SqlFailure('auth', `Access denied (using password: ${PASSWORD})`)
        })
        const e = await error(await handle(post({ credential: 'DB', sql: 'select' })))
        expect(e.code).toBe('KEYCHAIN_DB_AUTH_FAILED')
        expect(e.message).not.toContain(PASSWORD)
    })

    test('redactJson keeps the shape', () => {
        expect(redactJson({ a: ['x', 1, null, true] }, [])).toEqual({ a: ['x', 1, null, true] })
        expect(redactJson({ a: ['pw!', 7] }, ['pw!'])).toEqual({ a: [REDACTED, 7] })
    })
})

describe('/sql: the body cannot send the password elsewhere', () => {
    // A listener of the agent's own on the SSH server, or another port of the
    // database host, would catch the password (or its scramble).
    test('behind the tunnel, another host than the credential’s', async () => {
        const { handle, tunnels, runs } = setup({ 'DB prod': PROD_DB, Bastion: BASTION })
        const res = await handle(post({ ...VIA_BASTION, host: '10.1.2.3' }))
        expect((await error(res)).code).toBe('KEYCHAIN_WRONG_SITE')
        expect(tunnels).toEqual([])
        expect(runs).toEqual([])
    })

    test('behind the tunnel, another port than the credential’s', async () => {
        const { handle, tunnels } = setup({ 'DB prod': PROD_DB, Bastion: BASTION })
        const res = await handle(post({ ...VIA_BASTION, port: 3307 }))
        expect((await error(res)).code).toBe('KEYCHAIN_WRONG_SITE')
        expect(tunnels).toEqual([])
    })

    test('the same host and port as the credential are fine', async () => {
        const { handle } = setup({ 'DB prod': PROD_DB, Bastion: BASTION })
        const res = await handle(post({ ...VIA_BASTION, host: '127.0.0.1', port: 3306 }))
        expect(res.status).toBe(200)
    })

    test('a credential without host or port: only loopback and the default port', async () => {
        const bare: FakeCredential = {
            ...PROD_DB,
            fields: { username: 'app', password: PASSWORD },
        }
        const ok = setup({ 'DB prod': bare, Bastion: BASTION })
        expect((await ok.handle(post({ ...VIA_BASTION, host: 'localhost' }))).status).toBe(200)
        expect(ok.tunnels[0]).toMatchObject({ dst_host: 'localhost', dst_port: 3306 })
        for (const body of [
            { ...VIA_BASTION, host: 'db.internal' },
            { ...VIA_BASTION, port: 3307 },
        ]) {
            const s = setup({ 'DB prod': bare, Bastion: BASTION })
            expect((await error(await s.handle(post(body)))).code).toBe('KEYCHAIN_WRONG_SITE')
            expect(s.tunnels).toEqual([])
        }
    })

    test('another SSH port than the credential’s (or 22)', async () => {
        const { handle, tunnels } = setup({ 'DB prod': PROD_DB, Bastion: BASTION })
        const res = await handle(post({ ...VIA_BASTION, ssh: { ...VIA_BASTION.ssh, port: 2222 } }))
        expect((await error(res)).code).toBe('KEYCHAIN_WRONG_SITE')
        expect(tunnels).toEqual([])
    })

    test('direct: another port than the default when the credential has none', async () => {
        const { handle, runs } = setup({ DB: DIRECT_DB })
        const res = await handle(post({ credential: 'DB', sql: 'x', port: 4444 }))
        expect((await error(res)).code).toBe('KEYCHAIN_WRONG_SITE')
        expect(runs).toEqual([])
    })

    test('direct: another host than the credential’s', async () => {
        const { handle, runs } = setup({ DB: DIRECT_DB })
        const res = await handle(post({ credential: 'DB', sql: 'x', host: 'api.example.com' }))
        expect((await error(res)).code).toBe('KEYCHAIN_WRONG_SITE')
        expect(runs).toEqual([])
    })
})

describe('/sql: never the password in clear', () => {
    test('direct needs a name: TLS is verified against it', async () => {
        const { handle, runs } = setup({
            DB: {
                fields: { ...DIRECT_DB.fields, host: '203.0.114.10' },
                sites: [{ host: '203.0.114.10', subdomains: false }],
            },
        })
        const e = await error(await handle(post({ credential: 'DB', sql: 'x' })))
        expect(e.code).toBe('KEYCHAIN_DB_TLS_REQUIRED')
        expect(runs).toEqual([])
    })

    test('a server without valid TLS, or asking for the password as is', async () => {
        for (const [kind, code] of [
            ['tls', 'KEYCHAIN_DB_TLS_REQUIRED'],
            ['cleartext', 'KEYCHAIN_DB_AUTH_FAILED'],
        ] as const) {
            const { handle } = setup({ DB: DIRECT_DB }, async () => {
                throw new SqlFailure(kind, 'x')
            })
            expect((await error(await handle(post({ credential: 'DB', sql: 'x' })))).code).toBe(
                code
            )
        }
    })

    test('an SSH host key that changes is refused', () => {
        const known = new KnownHosts()
        expect(known.check('bastion:22', Buffer.from('key-a'))).toBe(true)
        expect(known.check('bastion:22', Buffer.from('key-a'))).toBe(true)
        expect(known.check('bastion:22', Buffer.from('key-b'))).toBe(false)
        expect(known.check('other:22', Buffer.from('key-b'))).toBe(true)
    })
})

test('innerSignature takes the blob out of an ssh-agent signature', () => {
    const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.from([1, 2, 3]))])
    expect([...innerSignature(blob)]).toEqual([1, 2, 3])
})
