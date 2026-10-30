/**
 * `/connect`: a TCP tunnel through a VPN credential, over a WebSocket
 * (credenciales-por-referencia.md, «VPN»). The agent runs
 * `ssh -o ProxyCommand='kj-connect "<VPN>" %h %p' …`; its launcher opens this
 * WebSocket with `X-Kj-Token`/`X-Kj-Session` and
 * `?credential=&host=&port=[&field=]`. Here the credential's auth key is
 * resolved like any reference, a `tailscaled` joins the tailnet with it
 * (tailnet.ts), and the bytes go through its SOCKS5 to host:port. The key never
 * enters the agent's container.
 *
 * Only through the tailnet (and, if the credential lists destinations, only to
 * them; with none, to any machine of the tailnet: that is what a VPN is for): an IP
 * has to be a Tailscale address, and a name is resolved by the node itself to
 * a peer's Tailscale IP, which is what the tunnel opens to (connect-target.ts,
 * tailnet.ts). Binary frames are the tunnel; a text frame from here is an
 * error `{ error: { code, message } }`, sent before closing.
 *
 * A tunnel already open is not cut if the person loses «Usar» or the
 * credential changes: the check is at opening, as for an HTTP request.
 */

import { isIP } from 'node:net'

import type { Server, ServerWebSocket, Socket } from 'bun'

import {
    SOCKS_GREETING,
    SocksError,
    describeSocksReply,
    isTailnetHost,
    parsePort,
    socksConnectRequest,
    socksReplyLength,
} from './connect-target'
import { KeychainError, errorResponse } from './errors'
import type { KeychainLog } from './log'
import type { AgentTokenRegistry } from './registry'
import type { Resolve } from './resolver'
import { describeSites, hostMatchesAnySite } from './sites'
import { type TailnetLease, TailnetError } from './tailnet'

export const CONNECT_PATH = '/connect'

const MAX_NAME = 200
const MAX_HOST = 253
/** What the agent may send before the tunnel is open. */
const MAX_EARLY_BYTES = 1024 * 1024
/** What may wait for a slow destination; past it the tunnel closes. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024
/** Tunnels one agent may have open at once (kj-keychain is shared by the host). */
const MAX_TUNNELS_PER_AGENT = 16
const HANDSHAKE_TIMEOUT_MS = 20_000

export interface ConnectData {
    agent_id: number
    session: string
    credential: string
    field: string
    host: string
    port: number
    tcp?: Socket<unknown>
    lease?: TailnetLease
    open: boolean
    closed: boolean
    early: Buffer[]
    early_bytes: number
    pending: Buffer[]
    pending_bytes: number
}

export interface ConnectDeps {
    registry: AgentTokenRegistry
    resolve: Resolve
    log: KeychainLog
    tailnet: { acquire: (authKey: string) => Promise<TailnetLease> }
}

export function createConnectHandler(deps: ConnectDeps) {
    const tunnels = new Map<number, number>()

    /** Checks what can be checked before upgrading; a Response = refused. */
    function upgrade(request: Request, server: Server<ConnectData>): Response | undefined {
        try {
            const agent_id = deps.registry.agentFor(request.headers.get('x-kj-token'))
            if (agent_id === null) {
                throw new KeychainError(
                    'KEYCHAIN_UNAUTHORIZED',
                    'Petición sin un token de agente válido.'
                )
            }
            const session = request.headers.get('x-kj-session')?.trim()
            if (!session) {
                throw new KeychainError(
                    'KEYCHAIN_BAD_REQUEST',
                    'Falta la sesión de la conversación.'
                )
            }
            const q = new URL(request.url).searchParams
            const credential = (q.get('credential') ?? '').trim()
            const field = (q.get('field') ?? 'auth_key').trim()
            const host = (q.get('host') ?? '').trim()
            const port = parsePort(q.get('port'))
            if (!credential || credential.length > MAX_NAME || !field || field.length > MAX_NAME) {
                throw new KeychainError(
                    'KEYCHAIN_BAD_REQUEST',
                    'Falta el nombre de la credencial de la VPN.'
                )
            }
            if (port === null) {
                throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'El puerto no es válido.')
            }
            if (host.length > MAX_HOST || !isTailnetHost(host)) {
                throw new KeychainError(
                    'KEYCHAIN_NOT_TAILNET',
                    `«${host.slice(0, 80)}» no es una dirección de la VPN. Usa la IP de Tailscale ` +
                        '(100.x.y.z) o el nombre de la máquina en la tailnet.'
                )
            }
            if ((tunnels.get(agent_id) ?? 0) >= MAX_TUNNELS_PER_AGENT) {
                throw new KeychainError(
                    'KEYCHAIN_TUNNEL_FAILED',
                    `Ya hay ${MAX_TUNNELS_PER_AGENT} conexiones abiertas por la VPN. Cierra alguna y repite.`,
                    429
                )
            }
            const data: ConnectData = {
                agent_id,
                session,
                credential,
                field,
                host,
                port,
                open: false,
                closed: false,
                early: [],
                early_bytes: 0,
                pending: [],
                pending_bytes: 0,
            }
            if (server.upgrade(request, { data })) {
                tunnels.set(agent_id, (tunnels.get(agent_id) ?? 0) + 1)
                return undefined
            }
            throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'Hace falta una conexión WebSocket.')
        } catch (error) {
            const e =
                error instanceof KeychainError
                    ? error
                    : new KeychainError('KEYCHAIN_BAD_REQUEST', 'Petición no válida.')
            deps.log('warn', 'connect refused', { code: e.code })
            return errorResponse(e)
        }
    }

    function fail(ws: ServerWebSocket<ConnectData>, error: KeychainError): void {
        deps.log('warn', 'connect failed', {
            agent_id: ws.data.agent_id,
            credential: ws.data.credential,
            host: ws.data.host,
            port: ws.data.port,
            code: error.code,
        })
        try {
            ws.send(JSON.stringify({ error: { code: error.code, message: error.message } }))
            ws.close(1011, error.code)
        } catch {}
    }

    function write(ws: ServerWebSocket<ConnectData>, tcp: Socket<unknown>, chunk: Buffer): void {
        const d = ws.data
        if (d.pending.length) {
            d.pending.push(chunk)
            d.pending_bytes += chunk.length
        } else {
            const written = tcp.write(chunk)
            if (written < chunk.length) {
                const rest = chunk.subarray(Math.max(written, 0))
                d.pending.push(rest)
                d.pending_bytes += rest.length
            }
        }
        if (d.pending_bytes > MAX_PENDING_BYTES) {
            ws.close(1009, 'destination too slow')
            tcp.end()
        }
    }

    /** Whether the agent hung up while we were waiting: then nothing more is opened. */
    function abandoned(ws: ServerWebSocket<ConnectData>): boolean {
        if (!ws.data.closed) return false
        ws.data.lease?.release()
        ws.data.tcp?.end()
        return true
    }

    async function open(ws: ServerWebSocket<ConnectData>): Promise<void> {
        const d = ws.data
        const ack = await deps.resolve({
            agent_id: d.agent_id,
            conversation_session_id: d.session,
            credential: d.credential,
            field: d.field,
        })
        if (abandoned(ws)) return
        if (!ack.ok) return fail(ws, new KeychainError(ack.code, ack.message))
        if (!ack.value.startsWith('tskey-')) {
            return fail(
                ws,
                new KeychainError(
                    'KEYCHAIN_NOT_VPN_KEY',
                    `«${d.credential}» no lleva una auth key de Tailscale (tskey-…) en «${d.field}».`
                )
            )
        }
        // A VPN is for reaching its network: with no destinations, any machine
        // of the tailnet (the tailnet-only rule below still holds); with some,
        // only those.
        if (ack.sites.length && !hostMatchesAnySite(d.host, ack.sites)) {
            return fail(
                ws,
                new KeychainError(
                    'KEYCHAIN_WRONG_SITE',
                    `Por la VPN «${d.credential}» sólo se llega a ${describeSites(ack.sites)}, no a ` +
                        `${d.host}. Si esa máquina también es suya, pide al operador que la añada a los destinos.`
                )
            )
        }
        try {
            d.lease = await deps.tailnet.acquire(ack.value)
        } catch (error) {
            return fail(
                ws,
                new KeychainError(
                    'KEYCHAIN_TUNNEL_FAILED',
                    error instanceof TailnetError
                        ? error.message
                        : 'No se ha podido levantar la VPN ahora mismo. Vuelve a intentarlo.'
                )
            )
        }
        if (abandoned(ws)) return

        // A name goes to the peer's tailnet IP, never to tailscaled's own
        // resolver: that one falls back to the system DNS and the host network.
        const target = isIP(d.host) ? d.host : await d.lease.resolve(d.host)
        if (abandoned(ws)) return
        if (!target) {
            return fail(
                ws,
                new KeychainError(
                    'KEYCHAIN_NOT_TAILNET',
                    `No hay ninguna máquina «${d.host}» en la VPN «${d.credential}». Usa su IP de ` +
                        'Tailscale (100.x.y.z) o el nombre con el que aparece en la tailnet.'
                )
            )
        }

        let phase: 'greet' | 'connect' | 'open' = 'greet'
        let buf = Buffer.alloc(0)
        const timer = setTimeout(() => {
            if (phase !== 'open') {
                fail(
                    ws,
                    new KeychainError(
                        'KEYCHAIN_TUNNEL_FAILED',
                        'La VPN no ha abierto la conexión a tiempo.'
                    )
                )
                d.tcp?.end()
            }
        }, HANDSHAKE_TIMEOUT_MS)
        try {
            d.tcp = await Bun.connect({
                hostname: '127.0.0.1',
                port: d.lease.socks_port,
                socket: {
                    open: (s) => {
                        s.write(SOCKS_GREETING)
                    },
                    data: (s, chunk) => {
                        if (d.closed) {
                            s.end()
                            return
                        }
                        if (phase === 'open') {
                            // 0 = dropped: the agent's side is gone or far behind.
                            if (ws.sendBinary(chunk) === 0) s.end()
                            return
                        }
                        buf = Buffer.concat([buf, Buffer.from(chunk)])
                        try {
                            if (phase === 'greet') {
                                if (buf.length < 2) return
                                if (buf[0] !== 5 || buf[1] !== 0) throw new SocksError(-1)
                                buf = buf.subarray(2)
                                phase = 'connect'
                                s.write(socksConnectRequest(target, d.port))
                            }
                            if (phase === 'connect') {
                                const length = socksReplyLength(buf)
                                if (length === null) return
                                const rest = buf.subarray(length)
                                buf = Buffer.alloc(0)
                                phase = 'open'
                                d.open = true
                                clearTimeout(timer)
                                deps.log('info', 'connect open', {
                                    agent_id: d.agent_id,
                                    credential: d.credential,
                                    host: d.host,
                                    port: d.port,
                                })
                                if (rest.length) ws.sendBinary(rest)
                                for (const early of d.early) write(ws, s, early)
                                d.early = []
                            }
                        } catch (error) {
                            clearTimeout(timer)
                            const reply = error instanceof SocksError ? error.reply : -1
                            fail(
                                ws,
                                new KeychainError(
                                    'KEYCHAIN_TUNNEL_FAILED',
                                    `No se ha podido conectar con ${d.host}:${d.port}: ${describeSocksReply(reply)}.`
                                )
                            )
                            s.end()
                        }
                    },
                    drain: (s) => {
                        while (d.pending.length) {
                            const chunk = d.pending[0] as Buffer
                            const written = s.write(chunk)
                            if (written < chunk.length) {
                                const rest = chunk.subarray(Math.max(written, 0))
                                d.pending_bytes -= chunk.length - rest.length
                                d.pending[0] = rest
                                return
                            }
                            d.pending_bytes -= chunk.length
                            d.pending.shift()
                        }
                    },
                    close: () => {
                        clearTimeout(timer)
                        try {
                            ws.close()
                        } catch {}
                    },
                    error: () => {
                        try {
                            ws.close()
                        } catch {}
                    },
                },
            })
        } catch {
            clearTimeout(timer)
            fail(ws, new KeychainError('KEYCHAIN_TUNNEL_FAILED', 'La VPN no responde ahora mismo.'))
            return
        }
        abandoned(ws)
    }

    const websocket = {
        open(ws: ServerWebSocket<ConnectData>) {
            open(ws).catch(() =>
                fail(
                    ws,
                    new KeychainError('KEYCHAIN_TUNNEL_FAILED', 'No se ha podido abrir el túnel.')
                )
            )
        },
        message(ws: ServerWebSocket<ConnectData>, message: string | Buffer) {
            if (typeof message === 'string') return
            const d = ws.data
            const chunk = Buffer.from(message)
            if (d.open && d.tcp) {
                write(ws, d.tcp, chunk)
                return
            }
            d.early_bytes += chunk.length
            if (d.early_bytes > MAX_EARLY_BYTES) {
                ws.close(1009, 'too much before the tunnel opened')
                return
            }
            d.early.push(chunk)
        },
        close(ws: ServerWebSocket<ConnectData>) {
            const d = ws.data
            if (d.closed) return
            d.closed = true
            d.tcp?.end()
            d.lease?.release()
            const n = (tunnels.get(d.agent_id) ?? 1) - 1
            if (n > 0) tunnels.set(d.agent_id, n)
            else tunnels.delete(d.agent_id)
        },
    }

    return { upgrade, websocket }
}
