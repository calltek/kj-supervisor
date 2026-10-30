import { afterAll, describe, expect, test } from 'bun:test'

import { type ConnectData, createConnectHandler } from './connect-handler'
import {
    isTailnetHost,
    parsePort,
    socksConnectRequest,
    socksReplyLength,
    SocksError,
} from './connect-target'
import type { KeychainResolveAck } from './control-protocol'
import { silentLog } from './log'
import { AgentTokenRegistry } from './registry'
import { daemonArgs, upArgs } from './tailnet'

describe('where a VPN tunnel may go', () => {
    test('tailnet addresses and MagicDNS names only', () => {
        for (const host of [
            '100.64.0.1',
            '100.101.102.103',
            '100.127.255.254',
            'delta',
            'delta.tail1234.ts.net',
            'fd7a:115c:a1e0::1',
        ]) {
            expect(isTailnetHost(host)).toBe(true)
        }
        for (const host of [
            '100.63.0.1',
            '100.128.0.1',
            '10.0.0.1',
            '192.168.1.10',
            '127.0.0.1',
            '169.254.169.254',
            'example.com',
            'localhost.localdomain',
            '::1',
            'localhost',
            '',
            'a b',
        ]) {
            expect(isTailnetHost(host)).toBe(false)
        }
    })

    test('ports', () => {
        expect(parsePort('91')).toBe(91)
        expect(parsePort('0')).toBeNull()
        expect(parsePort('65536')).toBeNull()
        expect(parsePort('22a')).toBeNull()
        expect(parsePort(null)).toBeNull()
    })

    test('SOCKS5 CONNECT for an IP and for a name', () => {
        expect([...socksConnectRequest('100.64.0.1', 22)]).toEqual([
            5, 1, 0, 1, 100, 64, 0, 1, 0, 22,
        ])
        expect([...socksConnectRequest('delta', 91)]).toEqual([
            5, 1, 0, 3, 5, 100, 101, 108, 116, 97, 0, 91,
        ])
    })

    test('the CONNECT reply: waits for all of it, and a refusal says which', () => {
        const ok = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        expect(socksReplyLength(ok.subarray(0, 6))).toBeNull()
        expect(socksReplyLength(Buffer.concat([ok, Buffer.from('extra')]))).toBe(10)
        expect(() => socksReplyLength(Buffer.from([5, 4, 0, 1, 0]))).toThrow(SocksError)
    })
})

const TOKEN = 'agent-token-7'
const SESSION = '11111111-2222-4333-8444-555555555555'

/** What each tunnel asked the SOCKS5 server for. */
const connects: Buffer[] = []

/** A SOCKS5 server that echoes what the tunnel sends once it is open. */
function fakeSocks() {
    return Bun.listen<{ phase: number }>({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
            open: (s) => {
                s.data = { phase: 0 }
            },
            data: (s, chunk) => {
                if (s.data.phase === 0) {
                    s.data.phase = 1
                    s.write(Buffer.from([5, 0]))
                } else if (s.data.phase === 1) {
                    s.data.phase = 2
                    connects.push(Buffer.from(chunk))
                    s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
                } else {
                    s.write(Buffer.concat([Buffer.from('echo:'), Buffer.from(chunk)]))
                }
            },
        },
    })
}

const leases = { held: 0, released: 0 }

/** A node whose MagicDNS knows `delta` (100.64.0.9) and nothing else. */
function serve(ack: KeychainResolveAck, socksPort: number) {
    const registry = new AgentTokenRegistry()
    registry.set(7, TOKEN)
    const handler = createConnectHandler({
        registry,
        resolve: async () => ack,
        log: silentLog,
        tailnet: {
            acquire: async () => {
                leases.held += 1
                return {
                    socks_port: socksPort,
                    resolve: async (name) => (name === 'delta' ? '100.64.0.9' : null),
                    release: () => {
                        leases.released += 1
                    },
                }
            },
        },
    })
    return Bun.serve<ConnectData, never>({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (req, server) => handler.upgrade(req, server),
        websocket: handler.websocket,
    })
}

function tunnel(port: number, host: string, send?: string) {
    return new Promise<{ binary: string; errors: string[]; closed: boolean }>((resolve) => {
        const out = { binary: '', errors: [] as string[], closed: false }
        const ws = new WebSocket(
            `ws://127.0.0.1:${port}/connect?credential=VPN&host=${host}&port=91`,
            { headers: { 'X-Kj-Token': TOKEN, 'X-Kj-Session': SESSION } } as never
        )
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => {
            if (send) ws.send(Buffer.from(send))
        }
        ws.onmessage = (e) => {
            if (typeof e.data === 'string') out.errors.push(e.data)
            else out.binary += Buffer.from(e.data as ArrayBuffer).toString()
        }
        ws.onclose = () => {
            out.closed = true
            resolve(out)
        }
        setTimeout(() => {
            ws.close()
        }, 800)
    })
}

describe('/connect', () => {
    const socks = fakeSocks()
    afterAll(() => socks.stop(true))
    const KEY = 'tskey-auth-prueba'

    test('opens a tunnel to a destination of the credential, bytes both ways', async () => {
        const server = serve(
            { ok: true, value: KEY, sites: [{ host: '100.64.0.9', subdomains: false }] },
            socks.port
        )
        const out = await tunnel(server.port as number, '100.64.0.9', 'SSH-2.0-test')
        expect(out.errors).toEqual([])
        expect(out.binary).toBe('echo:SSH-2.0-test')
        server.stop(true)
    })

    test('a host that is not a destination is refused, with the reason', async () => {
        const server = serve(
            { ok: true, value: KEY, sites: [{ host: '100.64.0.9', subdomains: false }] },
            socks.port
        )
        const out = await tunnel(server.port as number, '100.64.0.10', 'x')
        expect(out.errors.join()).toContain('KEYCHAIN_WRONG_SITE')
        expect(out.binary).toBe('')
        server.stop(true)
    })

    test('a credential that is not a Tailscale key never reaches tailscaled', async () => {
        const server = serve(
            { ok: true, value: 'sk_live_x', sites: [{ host: '100.64.0.9', subdomains: false }] },
            socks.port
        )
        const out = await tunnel(server.port as number, '100.64.0.9')
        expect(out.errors.join()).toContain('KEYCHAIN_NOT_VPN_KEY')
        server.stop(true)
    })

    test('outside the tailnet, or without a valid token: refused before upgrading', async () => {
        const server = serve({ ok: true, value: KEY, sites: [] }, socks.port)
        const base = `http://127.0.0.1:${server.port}/connect?credential=VPN&port=22`
        const headers = { 'X-Kj-Token': TOKEN, 'X-Kj-Session': SESSION }
        const lan = await fetch(`${base}&host=192.168.1.1`, { headers })
        expect(lan.status).toBe(400)
        expect(lan.headers.get('x-kj-keychain-error')).toBe('KEYCHAIN_NOT_TAILNET')
        const forged = await fetch(`${base}&host=100.64.0.9`, {
            headers: { ...headers, 'X-Kj-Token': 'forged' },
        })
        expect(forged.status).toBe(401)
        server.stop(true)
    })
})

describe('/connect, the hard edges', () => {
    const socks = fakeSocks()
    afterAll(() => socks.stop(true))
    const KEY = 'tskey-auth-prueba'
    const DELTA = { ok: true as const, value: KEY, sites: [{ host: 'delta', subdomains: false }] }

    test('a name is opened to its tailnet IP, never handed to the SOCKS resolver', async () => {
        connects.length = 0
        const server = serve(DELTA, socks.port)
        const out = await tunnel(server.port as number, 'delta', 'x')
        expect(out.binary).toBe('echo:x')
        expect([...(connects[0] as Buffer)]).toEqual([5, 1, 0, 1, 100, 64, 0, 9, 0, 91])
        server.stop(true)
    })

    test('a name the tailnet does not know is refused, before any CONNECT', async () => {
        connects.length = 0
        const server = serve(
            { ok: true, value: KEY, sites: [{ host: 'ghost', subdomains: false }] },
            socks.port
        )
        const out = await tunnel(server.port as number, 'ghost', 'x')
        expect(out.errors.join()).toContain('KEYCHAIN_NOT_TAILNET')
        expect(connects).toHaveLength(0)
        server.stop(true)
    })

    test('every lease taken is given back when the tunnel closes', async () => {
        const before = { ...leases }
        const server = serve(DELTA, socks.port)
        await tunnel(server.port as number, 'delta', 'x')
        await Bun.sleep(50)
        expect(leases.held - before.held).toBe(1)
        expect(leases.released - before.released).toBe(1)
        server.stop(true)
    })
})

describe('the tailscale command lines', () => {
    test('the node takes nothing from the tailnet, and logs nowhere', () => {
        expect(upArgs('/tmp/ts-x/s', '/tmp/ts-x/authkey', 'kj')).toContain('--shields-up')
        expect(upArgs('/tmp/ts-x/s', '/tmp/ts-x/authkey', 'kj')).toContain(
            '--auth-key=file:/tmp/ts-x/authkey'
        )
        const daemon = daemonArgs('/tmp/ts-x', '/tmp/ts-x/s', 1055)
        expect(daemon).toContain('--tun=userspace-networking')
        expect(daemon).toContain('--state=mem:')
        expect(daemon).toContain('--no-logs-no-support')
        expect(daemon).toContain('--socks5-server=127.0.0.1:1055')
    })
})
