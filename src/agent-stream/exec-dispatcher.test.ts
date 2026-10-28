import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import {
    BINARIES_UID,
    ExecDispatcher,
    type ExecDocker,
    NEW_UIDS_PER_MINUTE,
    SHIM_CMD,
    UID_BASE,
    UidRegistry,
    parseRegistry,
    validExecRequest,
} from './exec-dispatcher'
import { AgentStreamManager } from './stream-manager'

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
const OTHER = '49618476-f503-4dc3-b1f6-4e15ff603418'

/** A volume whose registry file is `vol.json`; `failWrites` makes the next saves fail. */
function setup(mode: 'none' | 'root' | 'exec' = 'exec', initial: string | null = null) {
    const vol = { json: initial, failWrites: 0, writes: 0 }
    const execs: Array<{ container_id: string; user: string; cmd: string[]; env: string[] }> = []
    const replies: Array<Record<string, unknown>> = []
    const fences: Array<{ container_id: string; uid: number }> = []
    const fence = { fails: false }
    let inspectFails = 0
    const docker: ExecDocker = {
        containerIsolationMode: async () => {
            if (inspectFails > 0) {
                inspectFails--
                throw new Error('inspect failed')
            }
            return mode
        },
        isolationVolumeOf: async () => 'kj-agent-1-iso',
        readUidRegistry: async () => vol.json,
        writeUidRegistry: async (_v, json) => {
            if (vol.failWrites > 0) {
                vol.failWrites--
                throw new Error('helper exited 1')
            }
            vol.writes++
            vol.json = json
        },
        fenceBrowserNetwork: async (container_id, uid) => {
            if (fence.fails) throw new Error('iptables-restore: Permission denied')
            fences.push({ container_id, uid })
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
    const ask = (line: Record<string, unknown>, container = 'c1') =>
        d.onRequest(1, container, { kj_channel: 'exec', token: TOKEN, ...line })
    return {
        vol,
        execs,
        replies,
        fences,
        fence,
        ask,
        failInspect: (n: number) => {
            inspectFails = n
        },
    }
}

const uidsOnVolume = (json: string | null) => parseRegistry(json).bySession

describe('validExecRequest', () => {
    test('only the known ops, a 64-hex token and a session id', () => {
        const ok = { kj_channel: 'exec', op: 'spawn', token: TOKEN, session_id: SID }
        expect(validExecRequest(ok)).toBe(true)
        expect(validExecRequest({ ...ok, op: 'run' })).toBe(false)
        expect(validExecRequest({ ...ok, token: 'xyz' })).toBe(false)
        expect(validExecRequest({ ...ok, session_id: '../etc' })).toBe(false)
    })

    test("a browser's key goes only with op browser, and op browser only with it", () => {
        const browser = {
            kj_channel: 'exec',
            op: 'browser',
            token: TOKEN,
            session_id: 'kj-browser-7',
        }
        expect(validExecRequest(browser)).toBe(true)
        // A conversation named like a browser would get its uid, and its profile.
        expect(validExecRequest({ ...browser, op: 'spawn' })).toBe(false)
        expect(validExecRequest({ ...browser, op: 'purge' })).toBe(false)
        expect(validExecRequest({ ...browser, session_id: SID })).toBe(false)
        expect(validExecRequest({ ...browser, session_id: 'kj-browser-0' })).toBe(false)
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

describe('UidRegistry — never two conversations with one uid', () => {
    test('a failed save hands out nothing, and the next one saves for real', async () => {
        const s = setup()
        s.vol.failWrites = 1
        await s.ask({ op: 'spawn', session_id: SID })
        expect(s.execs).toHaveLength(0)
        expect(s.replies[0]?.ok).toBe(false)

        await s.ask({ op: 'spawn', session_id: SID })
        await s.ask({ op: 'spawn', session_id: OTHER })
        const onVolume = uidsOnVolume(s.vol.json)
        expect(onVolume[SID]).toBeDefined()
        expect(onVolume[OTHER]).toBeDefined()
        expect(onVolume[SID]).not.toBe(onVolume[OTHER])
        expect(s.execs.map((e) => e.user)).toEqual([
            `${onVolume[SID]}:${onVolume[SID]}`,
            `${onVolume[OTHER]}:${onVolume[OTHER]}`,
        ])
    })

    test('two requests for the same new conversation share one save', async () => {
        const reg = new UidRegistry(parseRegistry(null), {
            read: async () => null,
            write: async () => {},
        })
        const [a, b] = await Promise.all([reg.uidFor(SID), reg.uidFor(SID)])
        expect(a).toBe(b)
    })

    test('uids another launcher added since it was read are never handed again', async () => {
        const s = setup('exec', JSON.stringify({ bySession: {}, next: UID_BASE }))
        await s.ask({ op: 'spawn', session_id: SID })
        // Meanwhile a root image gave UID_BASE + 1 to someone else.
        const reg = parseRegistry(s.vol.json)
        s.vol.json = JSON.stringify({
            bySession: { ...reg.bySession, other: UID_BASE + 1 },
            next: UID_BASE + 2,
        })
        await s.ask({ op: 'spawn', session_id: OTHER })
        expect(uidsOnVolume(s.vol.json)[OTHER]).toBe(UID_BASE + 2)
        expect(uidsOnVolume(s.vol.json).other).toBe(UID_BASE + 1)
    })

    test('a new container of the agent reads the registry again', async () => {
        const s = setup('exec', JSON.stringify({ bySession: {}, next: UID_BASE }))
        await s.ask({ op: 'spawn', session_id: SID }, 'c1')
        s.vol.json = JSON.stringify({ bySession: { [OTHER]: UID_BASE + 7 }, next: UID_BASE + 8 })
        await s.ask({ op: 'spawn', session_id: OTHER }, 'c2')
        expect(s.execs.at(-1)?.user).toBe(`${UID_BASE + 7}:${UID_BASE + 7}`)
    })

    test('new conversations are capped per minute', async () => {
        let t = 0
        const reg = new UidRegistry(
            parseRegistry(null),
            {
                read: async () => null,
                write: async () => {},
            },
            () => t
        )
        for (let i = 0; i < NEW_UIDS_PER_MINUTE; i++) await reg.uidFor(`s${i}`)
        await expect(reg.uidFor('one-more')).rejects.toThrow('too many')
        t = 61_000
        await expect(reg.uidFor('one-more')).resolves.toBeNumber()
    })
})

describe('ExecDispatcher', () => {
    test('runs the fixed shim as the conversation uid', async () => {
        const s = setup()
        await s.ask({ op: 'spawn', session_id: SID })
        expect(s.execs).toEqual([
            {
                container_id: 'c1',
                user: `${UID_BASE}:${UID_BASE}`,
                cmd: SHIM_CMD,
                env: [`KJ_EXEC_TOKEN=${TOKEN}`],
            },
        ])
        expect(s.replies).toEqual([{ type: 'exec', token: TOKEN, ok: true, uid: UID_BASE }])
    })

    test('keeps the uid a conversation already had, without saving', async () => {
        const s = setup(
            'exec',
            JSON.stringify({ bySession: { [SID]: UID_BASE + 16 }, next: UID_BASE + 20 })
        )
        await s.ask({ op: 'spawn', session_id: SID })
        expect(s.execs[0]?.user).toBe(`${UID_BASE + 16}:${UID_BASE + 16}`)
        expect(s.vol.writes).toBe(0)
    })

    test('binaries always run as their own uid, whatever the session says', async () => {
        const s = setup(
            'exec',
            JSON.stringify({ bySession: { [SID]: UID_BASE }, next: UID_BASE + 1 })
        )
        await s.ask({ op: 'binaries', session_id: SID })
        expect(s.execs[0]?.user).toBe(`${BINARIES_UID}:${BINARIES_UID}`)
    })

    test('refuses an image that does not isolate through exec', async () => {
        for (const mode of ['none', 'root'] as const) {
            const s = setup(mode)
            await s.ask({ op: 'spawn', session_id: SID })
            expect(s.execs).toHaveLength(0)
            expect(s.replies[0]?.ok).toBe(false)
        }
    })

    test('a failed inspect refuses that request only, and is asked again', async () => {
        const s = setup()
        s.failInspect(1)
        await s.ask({ op: 'spawn', session_id: SID })
        expect(s.execs).toHaveLength(0)
        await s.ask({ op: 'spawn', session_id: SID })
        expect(s.execs).toHaveLength(1)
    })

    test("a browser's network is cut for its uid before it starts, and only for a browser", async () => {
        const s = setup()
        await s.ask({ op: 'spawn', session_id: SID })
        expect(s.fences).toHaveLength(0)
        await s.ask({ op: 'browser', session_id: 'kj-browser-7' })
        expect(s.fences).toEqual([{ container_id: 'c1', uid: UID_BASE + 1 }])
        expect(s.execs[1]?.user).toBe(`${UID_BASE + 1}:${UID_BASE + 1}`)
    })

    test('without the fence, no browser', async () => {
        const s = setup()
        s.fence.fails = true
        await s.ask({ op: 'browser', session_id: 'kj-browser-7' })
        expect(s.execs).toHaveLength(0)
        expect(s.replies[0]?.ok).toBe(false)
    })

    test('a purge never assigns a uid', async () => {
        const s = setup()
        await s.ask({ op: 'purge', session_id: SID })
        expect(s.execs).toHaveLength(0)
        expect(s.vol.writes).toBe(0)
        expect(s.replies[0]?.ok).toBe(false)
    })
})

describe('AgentStreamManager routes exec requests', () => {
    test('to the dispatcher, never to the control as output', async () => {
        const duplex = new PassThrough()
        const pushed: string[] = []
        const seen: Array<Record<string, unknown>> = []
        const manager = new AgentStreamManager({
            docker: {
                attachContainer: async () => duplex,
                demuxAttachStream: (
                    stream: NodeJS.ReadWriteStream,
                    stdout: NodeJS.WritableStream
                ) => {
                    stream.pipe(stdout)
                },
                inspect: async () => ({ Config: { Env: [] } }),
            } as never,
            client: {
                push(event: string) {
                    pushed.push(event)
                },
            } as never,
            logger: silentLogger(),
            exec: {
                onRequest: async (_a: number, _c: string, line: Record<string, unknown>) => {
                    seen.push(line)
                },
            } as never,
        })
        await manager.attach({ agent_id: 1, container_id: 'c1', session_id: 'sess' })
        duplex.write(
            `${JSON.stringify({ kj_channel: 'exec', op: 'spawn', token: TOKEN, session_id: SID })}\n`
        )
        await new Promise((r) => setTimeout(r, 20))
        expect(seen).toHaveLength(1)
        expect(pushed).not.toContain('agent:output')
    })
})
