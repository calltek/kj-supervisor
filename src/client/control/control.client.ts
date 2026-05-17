/**
 * Thin wrapper around socket.io-client tailored to the supervisor ↔
 * control protocol. The wrapper hides Socket.IO's surface area behind a
 * small interface that matches our handshake flow:
 *
 *   client.on('ready', ...)        // control:ready arrived (auth done)
 *   client.on('protocol_error', ..)// control sent protocol:error
 *   client.on('disconnect', ...)   // connection dropped
 *   client.emitWithAck(...)        // emit + await ack with timeout
 *
 * Reconnection is delegated to Socket.IO (exponential backoff with
 * jitter). Whoever owns the client re-runs the handshake every time
 * the `ready` event fires — that handles both the initial connect and
 * subsequent reconnects identically.
 */

import { EventEmitter } from 'node:events'
import { io, type Socket } from 'socket.io-client'

import type { WsErrorPayload } from '../../protocol'
import type { KJLogger } from '../../logger'

export interface ControlClientOptions {
    /** Base URL of the control, e.g. `http://localhost:5050`. */
    url: string
    /** Initial handshake auth. Can be reassigned in-place after agent_token mint. */
    auth: Record<string, string>
    logger: KJLogger
}

export class KJControlClient extends EventEmitter {
    private readonly socket: Socket
    private readonly logger: KJLogger

    constructor(opts: ControlClientOptions) {
        super()
        this.logger = opts.logger.child({ component: 'control-client' })

        this.socket = io(`${opts.url}/agents`, {
            transports: ['websocket'],
            auth: opts.auth,
            autoConnect: false,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30000,
            randomizationFactor: 0.5,
        })

        this.socket.on('connect', () => {
            this.logger.info({ id: this.socket.id }, 'socket connected, waiting for control:ready')
        })

        this.socket.on('control:ready', () => {
            this.logger.info('control:ready received')
            this.emit('ready')
        })

        this.socket.on('protocol:error', (payload: WsErrorPayload) => {
            this.logger.warn({ payload }, 'protocol:error from control')
            this.emit('protocol_error', payload)
        })

        this.socket.on('disconnect', (reason) => {
            this.logger.warn({ reason }, 'socket disconnected')
            this.emit('disconnect', reason)
        })

        this.socket.on('connect_error', (err) => {
            this.logger.warn({ err: err.message }, 'connect_error')
        })

        this.socket.io.on('reconnect_attempt', (attempt) => {
            this.logger.debug({ attempt }, 'reconnect attempt')
        })
    }

    /** Start the connection. Idempotent. */
    connect(): void {
        if (this.socket.connected) return
        this.socket.connect()
    }

    /** Hard close. No reconnection. */
    disconnect(): void {
        this.logger.info('disconnecting (no reconnect)')
        this.socket.disconnect()
    }

    /**
     * Drop the underlying transport and let Socket.IO reconnect with
     * its exponential backoff. Use this when the connection looks
     * stuck (e.g. consecutive health:ping timeouts) — calling
     * `socket.disconnect()` instead would mark the manager as
     * client-closed and skip reconnection.
     */
    forceReconnect(reason: string): void {
        this.logger.warn({ reason }, 'forcing reconnect — dropping transport')
        // engine.close() drops the websocket without telling the Manager
        // it was a client-initiated close, so reconnection still kicks in.
        this.socket.io.engine?.close()
    }

    /**
     * Replace the auth payload used for future reconnections. Call this
     * after the control mints an agent_token so subsequent reconnects
     * use it instead of the (now-consumed) provisioning_token.
     */
    setAuth(next: Record<string, string>): void {
        // socket.io-client exposes auth as a mutable object.
        ;(this.socket as unknown as { auth: Record<string, string> }).auth = next
    }

    /** Fire-and-forget push. Used for events the control doesn't ack. */
    push(event: string, payload: unknown): void {
        this.socket.emit(event, payload)
    }

    /**
     * Subscribe to a control-driven command. The handler runs on every
     * event and its return value (or resolved promise) is sent back as
     * the ack. Errors thrown become INTERNAL_ERROR acks so a buggy
     * handler never leaves the control hanging.
     */
    onCommand<TPayload, TAck>(
        event: string,
        handler: (payload: TPayload) => Promise<TAck> | TAck
    ): void {
        this.socket.on(event, async (payload: TPayload, ack?: (response: unknown) => void) => {
            try {
                const result = await handler(payload)
                if (ack) ack(result)
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                this.logger.error({ event, err: message }, 'handler threw')
                if (ack) {
                    ack({
                        ok: false,
                        error: {
                            code: 'INTERNAL_ERROR',
                            message,
                            retryable: false,
                        },
                    })
                }
            }
        })
    }

    /**
     * Emit an event and await its ack. Rejects on timeout. The control
     * does NOT send error payloads via the ack channel for our use
     * cases — fatal errors come via `protocol:error` instead, so the
     * resolved value here is always the success payload.
     */
    emitWithAck<TAck>(event: string, payload: unknown, timeoutMs: number): Promise<TAck> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                reject(new Error(`ack timeout for ${event} after ${timeoutMs}ms`))
            }, timeoutMs)

            this.socket.emit(event, payload, (ack: TAck) => {
                clearTimeout(t)
                resolve(ack)
            })
        })
    }

    /** True if Socket.IO considers the underlying connection up. */
    get connected(): boolean {
        return this.socket.connected
    }
}
