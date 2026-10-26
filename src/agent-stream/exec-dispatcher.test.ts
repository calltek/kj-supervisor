import { describe, expect, test } from 'bun:test'

import {
    BINARIES_UID,
    ExecDispatcher,
    type ExecDocker,
    SHIM_CMD,
    UID_BASE,
    parseRegistry,
    validExecRequest,
} from './exec-dispatcher'

function silentLogger() {
    const noop = () => {}
    const fakeLogger = {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        fatal: noop,
        trace: noop,
        child: () => fakeLogger,
    }
    return fakeLogger as unknown as ConstructorParameters<typeof ExecDispatcher>[0]['logger']
}

const TOKEN = 'a'.repeat(64)
const SID = '17d0e6d9-b5d0-4049-a7b7-30b5f7ea3e48'

function setup(mode: 'none' | 'root' | 'exec' = 'exec', stored: string | null = null) {
    const execs: Array<{ user: string; cmd: string[]; env: string[] }> = []
    const saved: string[] = []
    const replies: Array<Record<string, unknown>> = []
    const docker: ExecDocker = {
        containerIsolationMode: async () => mode,
        isolationVolumeOf: async () => 'kj-agent-1-iso',
        readUidRegistry: async () => stored,
        writeUidRegistry: async (_v, json) => {
            saved.push(json)
        },
        execDetached: async (o) => {
            execs.push(o)
        },
    }
    const d = new ExecDispatcher({
        docker,
        reply: (_id, env) => {
            replies.push(env)
            return true
        },
        logger: silentLogger(),
    })
    const ask = (line: Record<string, unknown>) =>
        d.onRequest(1, 'c1', { kj_channel: 'exec', ...line })
    return { execs, saved, replies, ask }
}

describe('validExecRequest', () => {
    test('only the three ops, a 64-hex token and a session id', () => {
        const ok = { kj_channel: 'exec', op: 'spawn', token: TOKEN, session_id: SID }
        expect(validExecRequest(ok)).toBe(true)
        expect(validExecRequest({ ...ok, op: 'run' })).toBe(false)
        expect(validExecRequest({ ...ok, token: 'xyz' })).toBe(false)
        expect(validExecRequest({ ...ok, session_id: '../etc' })).toBe(false)
    })
})

describe('parseRegistry', () => {
    // A registry naming root, the agent user or anything outside the range
    // would run a conversation as that user.
    test('drops uids outside the conversation range', () => {
        const reg = parseRegistry(
            JSON.stringify({ bySession: { a: 0, b: 1000, c: 998, d: UID_BASE + 3 }, next: 5 })
        )
        expect(reg.bySession).toEqual({ d: UID_BASE + 3 })
        expect(reg.next).toBe(UID_BASE + 4)
    })
})

describe('ExecDispatcher', () => {
    test('runs the fixed shim as the conversation uid, saving the uid first', async () => {
        const s = setup()
        await s.ask({ op: 'spawn', token: TOKEN, session_id: SID })
        expect(s.saved).toHaveLength(1)
        expect(s.execs).toEqual([
            {
                container_id: 'c1',
                user: `${UID_BASE}:${UID_BASE}`,
                cmd: SHIM_CMD,
                env: [`KJ_EXEC_TOKEN=${TOKEN}`],
            },
        ] as never)
        expect(s.replies).toEqual([{ type: 'exec', token: TOKEN, ok: true, uid: UID_BASE }])
    })

    test('keeps the uid a conversation already had', async () => {
        const s = setup(
            'exec',
            JSON.stringify({ bySession: { [SID]: UID_BASE + 16 }, next: UID_BASE + 20 })
        )
        await s.ask({ op: 'spawn', token: TOKEN, session_id: SID })
        expect(s.execs[0]?.user).toBe(`${UID_BASE + 16}:${UID_BASE + 16}`)
        expect(s.saved).toHaveLength(0)
    })

    test('binaries always run as their own uid, whatever the session says', async () => {
        const s = setup(
            'exec',
            JSON.stringify({ bySession: { [SID]: UID_BASE }, next: UID_BASE + 1 })
        )
        await s.ask({ op: 'binaries', token: TOKEN, session_id: SID })
        expect(s.execs[0]?.user).toBe(`${BINARIES_UID}:${BINARIES_UID}`)
    })

    test('refuses an image that does not isolate through exec', async () => {
        for (const mode of ['none', 'root'] as const) {
            const s = setup(mode)
            await s.ask({ op: 'spawn', token: TOKEN, session_id: SID })
            expect(s.execs).toHaveLength(0)
            expect(s.replies[0]?.ok).toBe(false)
        }
    })

    test('a purge never assigns a uid', async () => {
        const s = setup()
        await s.ask({ op: 'purge', token: TOKEN, session_id: SID })
        expect(s.execs).toHaveLength(0)
        expect(s.saved).toHaveLength(0)
        expect(s.replies[0]?.ok).toBe(false)
    })
})
