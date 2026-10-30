/**
 * The control channel, kj-keychain side: a WebSocket on `/control` that the
 * supervisor opens with `Authorization: Bearer <KJ_KEYCHAIN_CONTROL_SECRET>`.
 * One supervisor at a time: a new connection replaces the previous one.
 */

import type { KeychainControlDown, KeychainControlUp } from './control-protocol'
import type { KeychainLog } from './log'
import { type AgentTokenRegistry, safeEqual } from './registry'
import type { ControlLink, ResolveCache } from './resolver'

export const CONTROL_PATH = '/control'

/** Close code sent to a connection that a newer one replaced. */
export const REPLACED_CLOSE_CODE = 4000

export interface ControlDeps {
    secret: string
    registry: AgentTokenRegistry
    link: ControlLink
    cache: ResolveCache
    log: KeychainLog
}

export function isAuthorizedControl(header: string | null, secret: string): boolean {
    if (!header || !secret) return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match?.[1]) return false
    return safeEqual(match[1], secret)
}

/** Applies one supervisor → kj-keychain message. Malformed ones are dropped. */
export function applyControlMessage(raw: string, deps: ControlDeps): void {
    let message: KeychainControlDown
    try {
        message = JSON.parse(raw) as KeychainControlDown
    } catch {
        deps.log('warn', 'control message is not JSON')
        return
    }
    if (!message || typeof message !== 'object') return
    switch (message.type) {
        case 'agents:reset': {
            if (!Array.isArray(message.agents)) return
            deps.registry.reset(message.agents)
            deps.cache.clear()
            deps.log('info', 'agents reset', { agents: deps.registry.agents().length })
            return
        }
        case 'agent:token':
            deps.registry.set(message.agent_id, message.token)
            deps.cache.forgetAgent(message.agent_id)
            deps.log('info', 'agent token set', { agent_id: message.agent_id })
            return
        case 'agent:forget':
            deps.registry.forget(message.agent_id)
            deps.cache.forgetAgent(message.agent_id)
            deps.log('info', 'agent forgotten', { agent_id: message.agent_id })
            return
        case 'resolve:result':
            if (typeof message.id === 'string') deps.link.settle(message.id, message.ack)
            return
        default:
            deps.log('warn', 'unknown control message')
    }
}

interface ControlSocket {
    send(data: string): unknown
    close(code?: number, reason?: string): void
}

/** Tracks the current connection and wires it to the ControlLink. */
export class ControlSessions {
    private current: ControlSocket | null = null

    constructor(private readonly deps: ControlDeps) {}

    open(socket: ControlSocket): void {
        const previous = this.current
        this.current = socket
        this.deps.link.attach((message: KeychainControlUp) => {
            socket.send(JSON.stringify(message))
        })
        if (previous) {
            try {
                previous.close(REPLACED_CLOSE_CODE, 'replaced')
            } catch {}
        }
        this.deps.log('info', 'supervisor connected', { replaced: previous !== null })
    }

    message(socket: ControlSocket, data: string): void {
        if (socket !== this.current) return
        applyControlMessage(data, this.deps)
    }

    close(socket: ControlSocket): void {
        if (socket !== this.current) return
        this.current = null
        this.deps.link.detach()
        this.deps.log('warn', 'supervisor disconnected')
    }
}
