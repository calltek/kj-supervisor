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
 * Only to the tailnet (connect-target.ts) and only to the credential's
 * destinations. Binary frames are the tunnel; a text frame from here is an
 * error `{ error: { code, message } }`, sent before closing.
 */

import type { Server, ServerWebSocket, Socket } from 'bun'

import { KeychainError, errorResponse } from './errors'
import {
    SOCKS_GREETING,
    SocksError,
    describeSocksReply,
    isTailnetHost,
    parsePort,
    socksConnectRequest,
    socksReplyLength,
} from './connect-target'
import type { KeychainLog } from './log'
import type { AgentTokenRegistry } from './registry'
import type { Resolve } from './resolver'
import { describeSites, hostMatchesAnySite } from './sites'
import { TailnetError } from './tailnet'

export const CONNECT_PATH = '/connect'

const MAX_NAME = 200
/** What the agent may send before the tunnel is open. */
const MAX_EARLY_BYTES = 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 20_000

export interface ConnectData {
    agent_id: number
    session: string
    credential: string
    field: string
    host: string
    port: number
    tcp?: Socket<unknown>
    open: boolean
    early: Buffer[]
    early_bytes: number
    pending: Buffer[]
}

export interface ConnectDeps {
    registry: AgentTokenRegistry
    resolve: Resolve
    log: KeychainLog
    tailnet: { socksFor: (authKey: string) => Promise<number> }
}

export function createConnectHandler(deps: ConnectDeps) {
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
            if (!isTailnetHost(host)) {
                throw new KeychainError(
                    'KEYCHAIN_NOT_TAILNET',
                    `«${host}» no es una dirección de la VPN. Usa la IP de Tailscale (100.x.y.z) ` +
                        'o el nombre de la máquina en la tailnet.'
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
                early: [],
                early_bytes: 0,
                pending: [],
            }
            if (server.upgrade(request, { data })) return undefined
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
            host: ws.data.host,
            port: ws.data.port,
            code: error.code,
        })
        try {
            ws.send(JSON.stringify({ error: { code: error.code, message: error.message } }))
            ws.close(1011, error.code)
        } catch {}
    }

    function write(tcp: Socket<unknown>, data: ConnectData, chunk: Buffer): void {
        if (data.pending.length) {
            data.pending.push(chunk)
            return
        }
        const written = tcp.write(chunk)
        if (written < chunk.length) data.pending.push(chunk.subarray(Math.max(written, 0)))
    }

    async function open(ws: ServerWebSocket<ConnectData>): Promise<void> {
        const d = ws.data
        const ack = await deps.resolve({
            agent_id: d.agent_id,
            conversation_session_id: d.session,
            credential: d.credential,
            field: d.field,
        })
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
        if (!ack.sites.length) {
            return fail(
                ws,
                new KeychainError(
                    'KEYCHAIN_NO_DESTINATION',
                    `La VPN «${d.credential}» no tiene destinos: no se abre ninguna conexión por ella. ` +
                        'Pide al operador que añada en Credenciales las máquinas a las que se puede llegar.'
                )
            )
        }
        if (!hostMatchesAnySite(d.host, ack.sites)) {
            return fail(
                ws,
                new KeychainError(
                    'KEYCHAIN_WRONG_SITE',
                    `Por la VPN «${d.credential}» sólo se llega a ${describeSites(ack.sites)}, no a ` +
                        `${d.host}. Si esa máquina también es suya, pide al operador que la añada a los destinos.`
                )
            )
        }
        let socksPort: number
        try {
            socksPort = await deps.tailnet.socksFor(ack.value)
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
                port: socksPort,
                socket: {
                    open: (s) => {
                        s.write(SOCKS_GREETING)
                    },
                    data: (s, chunk) => {
                        if (phase === 'open') {
                            ws.sendBinary(chunk)
                            return
                        }
                        buf = Buffer.concat([buf, Buffer.from(chunk)])
                        try {
                            if (phase === 'greet') {
                                if (buf.length < 2) return
                                if (buf[0] !== 5 || buf[1] !== 0) throw new SocksError(-1)
                                buf = buf.subarray(2)
                                phase = 'connect'
                                s.write(socksConnectRequest(d.host, d.port))
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
                                    host: d.host,
                                    port: d.port,
                                })
                                if (rest.length) ws.sendBinary(rest)
                                for (const early of d.early) write(s, d, early)
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
                                d.pending[0] = chunk.subarray(Math.max(written, 0))
                                return
                            }
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
        }
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
                write(d.tcp, d, chunk)
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
            ws.data.tcp?.end()
        },
    }

    return { upgrade, websocket }
}
