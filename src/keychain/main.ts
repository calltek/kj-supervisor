/**
 * kj-keychain: runs credentials on behalf of the agents without the agents
 * ever holding the values (kj-agent-base `docs/credenciales-por-referencia.md`).
 *
 * Same image as the supervisor, started with `bun src/keychain/main.ts` in a
 * container with no capabilities, no docker.sock and a read-only root. No
 * state on disk: tokens and cached values live in memory only.
 */

import type { ServerWebSocket } from 'bun'

import { CONTROL_PATH, ControlSessions, isAuthorizedControl } from './control'
import { KEYCHAIN_AGENT_PORT, KEYCHAIN_CONTROL_PORT } from './control-protocol'
import { createKeychainHandler } from './handler'
import { log } from './log'
import { AgentTokenRegistry } from './registry'
import { ControlLink, ResolveCache } from './resolver'
import { CONNECT_PATH, type ConnectData, createConnectHandler } from './connect-handler'
import { createSshHandler, isSshPath } from './ssh-handler'
import { TailnetPool } from './tailnet'
import { hostname } from 'node:os'

const secret = process.env.KJ_KEYCHAIN_CONTROL_SECRET ?? ''
if (!secret) {
    log('error', 'KJ_KEYCHAIN_CONTROL_SECRET is required')
    process.exit(1)
}
// Nothing launched from here needs it.
delete process.env.KJ_KEYCHAIN_CONTROL_SECRET

const registry = new AgentTokenRegistry()
const link = new ControlLink()
const cache = new ResolveCache()
const sessions = new ControlSessions({ secret, registry, link, cache, log })
const resolve = cache.wrap(link.resolve)
const handleHttp = createKeychainHandler({ registry, resolve, log })
const handleSsh = createSshHandler({ registry, resolve, log })
const tailnet = new TailnetPool({ log, hostname: `kj-keychain-${hostname()}` })
const connect = createConnectHandler({ registry, resolve, log, tailnet })

Bun.serve<ConnectData, never>({
    hostname: '0.0.0.0',
    port: KEYCHAIN_AGENT_PORT,
    // Our own 32 MiB cap answers with a proper error; this is only a backstop.
    maxRequestBodySize: 64 * 1024 * 1024,
    // A destination may take a while; Bun's default (10 s) would cut it.
    idleTimeout: 255,
    fetch(request, server) {
        const path = new URL(request.url).pathname
        if (path === CONNECT_PATH) return connect.upgrade(request, server)
        return isSshPath(path) ? handleSsh(request) : handleHttp(request)
    },
    // An SSH session through a VPN stays open for as long as it is used.
    websocket: { ...connect.websocket, idleTimeout: 0 },
    error: () => {
        log('error', 'agent endpoint error')
        return new Response(null, { status: 500 })
    },
})

type ControlData = { connected_at: number }

Bun.serve<ControlData, never>({
    hostname: '0.0.0.0',
    port: KEYCHAIN_CONTROL_PORT,
    fetch(request, server) {
        if (new URL(request.url).pathname !== CONTROL_PATH) {
            return new Response(null, { status: 404 })
        }
        if (!isAuthorizedControl(request.headers.get('authorization'), secret)) {
            log('warn', 'control connection refused')
            return new Response(null, { status: 401 })
        }
        if (server.upgrade(request, { data: { connected_at: Date.now() } })) return undefined
        return new Response(null, { status: 400 })
    },
    websocket: {
        open: (ws: ServerWebSocket<ControlData>) => sessions.open(ws),
        message: (ws: ServerWebSocket<ControlData>, data) => {
            sessions.message(ws, typeof data === 'string' ? data : Buffer.from(data).toString())
        },
        close: (ws: ServerWebSocket<ControlData>) => sessions.close(ws),
    },
})

log('info', 'kj-keychain listening', {
    agent_port: KEYCHAIN_AGENT_PORT,
    control_port: KEYCHAIN_CONTROL_PORT,
})
