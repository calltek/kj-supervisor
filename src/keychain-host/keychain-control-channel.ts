/**
 * The supervisor's end of the kj-keychain control channel
 * (`src/keychain/control-protocol.ts`): a WebSocket to `/control` with the
 * secret as a bearer, reconnecting with a growing delay.
 *
 * Nothing here is ever logged beyond the message TYPE: `resolve:result` carries
 * the credential's value, and `agent:token` / `agents:reset` the agents' tokens.
 */

import type { KJLogger } from '../logger'
import type { KeychainControlDown, KeychainControlUp } from '../keychain/control-protocol'

/** The subset of a WebSocket this channel uses — Bun's global, or a fake in tests. */
export interface ControlSocket {
    readonly readyState: number
    send(data: string): void
    close(): void
    onopen: ((ev: unknown) => void) | null
    onclose: ((ev: unknown) => void) | null
    onerror: ((ev: unknown) => void) | null
    onmessage: ((ev: { data: unknown }) => void) | null
}

export type ControlSocketFactory = (url: string, secret: string) => ControlSocket

const OPEN = 1
const BACKOFF_START_MS = 1_000
const BACKOFF_MAX_MS = 30_000

export const bunSocketFactory: ControlSocketFactory = (url, secret) =>
    new WebSocket(url, {
        headers: { Authorization: `Bearer ${secret}` },
    }) as unknown as ControlSocket

export interface KeychainControlChannelDeps {
    url: string
    secret: string
    logger: KJLogger
    /** On every (re)connection — the place to send `agents:reset`. */
    onOpen: () => void
    onMessage: (msg: KeychainControlUp) => void
    socketFactory?: ControlSocketFactory
}

export class KeychainControlChannel {
    private socket: ControlSocket | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private delay = BACKOFF_START_MS
    private stopped = false

    constructor(private readonly deps: KeychainControlChannelDeps) {}

    start(): void {
        this.stopped = false
        this.connect()
    }

    stop(): void {
        this.stopped = true
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        const s = this.socket
        this.socket = null
        try {
            s?.close()
        } catch {
            /* already closed */
        }
    }

    get connected(): boolean {
        return this.socket?.readyState === OPEN
    }

    /** False when there is no open connection: the message is dropped, never queued. */
    send(msg: KeychainControlDown): boolean {
        if (!this.socket || this.socket.readyState !== OPEN) return false
        try {
            this.socket.send(JSON.stringify(msg))
            return true
        } catch (err) {
            this.deps.logger.warn(
                { type: msg.type, err: err instanceof Error ? err.message : String(err) },
                'keychain: control send failed'
            )
            return false
        }
    }

    private connect(): void {
        if (this.stopped) return
        let socket: ControlSocket
        try {
            socket = (this.deps.socketFactory ?? bunSocketFactory)(this.deps.url, this.deps.secret)
        } catch (err) {
            this.deps.logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'keychain: could not open the control channel'
            )
            this.scheduleReconnect()
            return
        }
        this.socket = socket
        socket.onopen = () => {
            if (this.socket !== socket) return
            this.delay = BACKOFF_START_MS
            this.deps.logger.info('keychain: control channel connected')
            this.deps.onOpen()
        }
        socket.onmessage = (ev) => {
            if (this.socket !== socket) return
            const msg = parseUp(ev.data)
            if (!msg) {
                this.deps.logger.warn('keychain: ignoring a malformed control message')
                return
            }
            this.deps.onMessage(msg)
        }
        socket.onerror = () => {
            // `onclose` follows; reconnect from there only.
        }
        socket.onclose = () => {
            if (this.socket !== socket) return
            this.socket = null
            this.scheduleReconnect()
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.timer) return
        const wait = this.delay
        this.delay = Math.min(this.delay * 2, BACKOFF_MAX_MS)
        this.deps.logger.debug({ wait_ms: wait }, 'keychain: control channel down, retrying')
        this.timer = setTimeout(() => {
            this.timer = null
            this.connect()
        }, wait)
    }
}

/** Only `resolve` comes up, and every field must be there with its type. */
export function parseUp(data: unknown): KeychainControlUp | null {
    const text =
        typeof data === 'string'
            ? data
            : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
              ? new TextDecoder().decode(data as ArrayBuffer)
              : null
    if (text === null) return null
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch {
        return null
    }
    if (!raw || typeof raw !== 'object') return null
    const m = raw as Record<string, unknown>
    if (m.type !== 'resolve') return null
    if (
        typeof m.id !== 'string' ||
        typeof m.agent_id !== 'number' ||
        !Number.isInteger(m.agent_id) ||
        typeof m.conversation_session_id !== 'string' ||
        typeof m.credential !== 'string' ||
        typeof m.field !== 'string'
    )
        return null
    return {
        type: 'resolve',
        id: m.id,
        agent_id: m.agent_id,
        conversation_session_id: m.conversation_session_id,
        credential: m.credential,
        field: m.field,
    }
}
