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
import { CommandDedup, requestIdOf } from './command-dedup'
import { fitToSocket, payloadBytes } from './socket-budget'

export interface ControlClientOptions {
    /** Base URL of the control, e.g. `http://localhost:5050`. */
    url: string
    /** Handshake auth — always `{ agent_token }` for this supervisor. */
    auth: Record<string, string>
    logger: KJLogger
}

export class KJControlClient extends EventEmitter {
    private readonly socket: Socket
    private readonly logger: KJLogger
    // Idempotency across ALL onCommand handlers: a repeated request_id
    // (the control's outbox retrying a lost-ack command) replays the
    // first ack instead of re-running the handler. See command-dedup.ts.
    private readonly dedup = new CommandDedup()
    // The newest push per key, waiting for the connection to free up
    // (`pushLatest`). Only the last one of each key is ever sent.
    private readonly latest = new Map<string, { event: string; payload: unknown }>()
    private draining = false

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
            // A frame of before the drop is old news: nothing waits across it.
            this.latest.clear()
            this.draining = false
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

    /** Fire-and-forget push. Used for events the control doesn't ack. */
    push(event: string, payload: unknown): void {
        const fit = this.fit(event, payload)
        if (fit) this.socket.emit(event, fit.payload)
    }

    /**
     * A push where only the newest one of its `key` matters (a browser's
     * frames): while the connection is still sending earlier ones, it waits
     * and a newer one replaces it, so a slow uplink shows the page of now, not
     * a queue of seconds ago. The one waiting goes out when the connection
     * drains: the last frame of a page that stops changing is never lost.
     * Offline it is dropped, not buffered for the reconnection.
     */
    pushLatest(key: string, event: string, payload: unknown): void {
        if (!this.socket.connected) return
        const engine = this.socket.io.engine as unknown as
            | {
                  writeBuffer?: unknown[]
                  transport?: { writable?: boolean }
                  once?(event: 'drain', fn: () => void): void
              }
            | undefined
        const busy =
            !!engine &&
            (engine.transport?.writable === false || (engine.writeBuffer?.length ?? 0) > 0)
        if (!busy || !engine?.once) {
            this.push(event, payload)
            return
        }
        this.latest.set(key, { event, payload })
        if (this.draining) return
        this.draining = true
        engine.once('drain', () => {
            if (!this.draining) return
            this.draining = false
            const waiting = [...this.latest.values()]
            this.latest.clear()
            for (const w of waiting) this.push(w.event, w.payload)
        })
    }

    /**
     * Lo que se va a emitir, recortado si pasa del tope del socket, o `null`
     * si ni recortado cabe (ver socket-budget.ts). Las dos cosas dejan rastro:
     * un evento recortado o perdido no se ve en ningún otro sitio.
     */
    /** Un ack que cabe, o un error en su lugar si ni recortado cabe. */
    private fitAck(event: string, response: unknown): unknown {
        const fit = this.fit(event, response)
        if (fit) return fit.payload
        return {
            ok: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: `ack for ${event} too large for the socket`,
                retryable: false,
            },
        }
    }

    private fit(event: string, payload: unknown): { payload: unknown } | null {
        const fit = fitToSocket(event, payload)
        if (!fit) {
            this.logger.error(
                { event, bytes: payloadBytes(event, payload) },
                'payload too large for the socket even after trimming — dropped'
            )
            return null
        }
        if (fit.shrunk) {
            this.logger.warn(
                { event, bytes: payloadBytes(event, payload) },
                'payload trimmed to fit the socket'
            )
        }
        return fit
    }

    /**
     * Subscribe to a control-driven push (no ack expected, e.g.
     * supervisor:upgrade-required). For events that DO ack, use
     * `onCommand`.
     */
    onPush<TPayload>(event: string, handler: (payload: TPayload) => void): void {
        this.socket.on(event, (payload: TPayload) => {
            try {
                handler(payload)
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                this.logger.error({ event, err: message }, 'push handler threw')
            }
        })
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
        this.socket.on(event, async (payload: TPayload, rawAck?: (response: unknown) => void) => {
            // Un ack también viaja por el socket: uno enorme lo cerraría y el
            // control se quedaría sin respuesta igual. Todos pasan por aquí,
            // también los que se repiten para un request_id ya visto.
            const ack = rawAck && ((response: unknown) => rawAck(this.fitAck(event, response)))
            // Idempotency: if this request_id already ran, replay its ack
            // and DON'T re-execute the handler (a retried at-least-once
            // command must not double-spawn / double-deliver).
            const request_id = requestIdOf(payload)
            if (request_id) {
                const prior = this.dedup.seen(request_id)
                if (prior) {
                    this.logger.debug({ event, request_id }, 'duplicate command — replaying ack')
                    if (ack) ack(prior.ack)
                    return
                }
                // Still running: wait for the first run and answer with its
                // ack, never run the handler twice.
                const running = this.dedup.inFlight(request_id)
                if (running) {
                    this.logger.debug(
                        { event, request_id },
                        'duplicate command — first still running'
                    )
                    const first = await running.catch((err) => ({
                        ok: false,
                        error: {
                            code: 'INTERNAL_ERROR',
                            message: err instanceof Error ? err.message : String(err),
                            retryable: false,
                        },
                    }))
                    if (ack) ack(first)
                    return
                }
            }
            const run = Promise.resolve().then(() => handler(payload))
            if (request_id) this.dedup.track(request_id, run)
            try {
                const result = await run
                if (request_id) this.dedup.remember(request_id, result)
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
            const fit = this.fit(event, payload)
            if (!fit) {
                reject(new Error(`${event} too large for the socket`))
                return
            }
            const t = setTimeout(() => {
                reject(new Error(`ack timeout for ${event} after ${timeoutMs}ms`))
            }, timeoutMs)

            this.socket.emit(event, fit.payload, (ack: TAck) => {
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
