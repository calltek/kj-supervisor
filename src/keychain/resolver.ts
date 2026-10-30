/**
 * Resolving a reference: ask the supervisor over the control channel
 * (`resolve` → `resolve:result`), with a timeout, and keep successes in
 * memory for 60 s per (agent, session, credential, field).
 */

import { randomUUID } from 'node:crypto'

import type { KeychainControlUp, KeychainResolveAck } from './control-protocol'

export const RESOLVE_TIMEOUT_MS = 10_000
export const CACHE_TTL_MS = 60_000

export interface ResolveRequest {
    agent_id: number
    conversation_session_id: string
    credential: string
    field: string
}

export type Resolve = (request: ResolveRequest) => Promise<KeychainResolveAck>

const UNAVAILABLE: KeychainResolveAck = {
    ok: false,
    code: 'KEYCHAIN_UNAVAILABLE',
    message:
        'No se ha podido consultar la credencial: el servidor no responde ahora mismo. ' +
        'Vuelve a intentarlo en un momento.',
}

interface Pending {
    resolve: (ack: KeychainResolveAck) => void
    timer: ReturnType<typeof setTimeout>
}

/**
 * The supervisor side of the channel. `attach` gives it the function that
 * sends a message on the current connection; `detach` fails everything in
 * flight (answers to it would arrive on a connection that no longer exists).
 */
export class ControlLink {
    private send: ((message: KeychainControlUp) => void) | null = null
    private readonly pending = new Map<string, Pending>()

    constructor(private readonly timeoutMs = RESOLVE_TIMEOUT_MS) {}

    attach(send: (message: KeychainControlUp) => void): void {
        this.failAll()
        this.send = send
    }

    detach(): void {
        this.send = null
        this.failAll()
    }

    connected(): boolean {
        return this.send !== null
    }

    resolve: Resolve = (request) => {
        const send = this.send
        if (!send) return Promise.resolve(UNAVAILABLE)
        const id = randomUUID()
        return new Promise<KeychainResolveAck>((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                resolve(UNAVAILABLE)
            }, this.timeoutMs)
            this.pending.set(id, { resolve, timer })
            try {
                send({ type: 'resolve', id, ...request })
            } catch {
                clearTimeout(timer)
                this.pending.delete(id)
                resolve(UNAVAILABLE)
            }
        })
    }

    /** `resolve:result` from the supervisor. Unknown or late ids are ignored. */
    settle(id: string, ack: KeychainResolveAck): void {
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.resolve(isAck(ack) ? ack : UNAVAILABLE)
    }

    private failAll(): void {
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer)
            this.pending.delete(id)
            entry.resolve(UNAVAILABLE)
        }
    }
}

function isAck(ack: unknown): ack is KeychainResolveAck {
    if (!ack || typeof ack !== 'object') return false
    const a = ack as Record<string, unknown>
    if (a.ok === true) return typeof a.value === 'string' && Array.isArray(a.sites)
    return a.ok === false && typeof a.code === 'string' && typeof a.message === 'string'
}

/** Successful resolutions, 60 s, keyed by (agent, session, credential, field). */
export class ResolveCache {
    private readonly entries = new Map<string, { ack: KeychainResolveAck; expires: number }>()

    constructor(
        private readonly ttlMs = CACHE_TTL_MS,
        private readonly now: () => number = Date.now
    ) {}

    wrap(resolve: Resolve): Resolve {
        return async (request) => {
            const key = JSON.stringify([
                request.agent_id,
                request.conversation_session_id,
                request.credential,
                request.field,
            ])
            const hit = this.entries.get(key)
            if (hit && hit.expires > this.now()) return hit.ack
            if (hit) this.entries.delete(key)
            const ack = await resolve(request)
            if (ack.ok) this.entries.set(key, { ack, expires: this.now() + this.ttlMs })
            return ack
        }
    }

    forgetAgent(agent_id: number): void {
        const prefix = `[${agent_id},`
        for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key)
    }

    clear(): void {
        this.entries.clear()
    }
}
