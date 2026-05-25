/**
 * Structured logger. Pino in production (stdout, picked up by Docker),
 * pino-pretty in development for readability. Tokens are redacted at
 * the serializer level so we never leak them in logs.
 */

import pino from 'pino'

import type { KJLogLevel } from './config/settings'

const REDACT_PATHS = ['auth.agent_token', 'agent_token', '*.agent_token']

type LogMethod = (objOrMsg: unknown, msg?: string) => void

export class KJLogger {
    private readonly pino: pino.Logger

    constructor(pinoInstance: pino.Logger) {
        this.pino = pinoInstance
    }

    /**
     * Build a root logger from the supervisor's settings. Pretty
     * transport in dev, raw JSON in prod (Docker picks it up).
     */
    static create(level: KJLogLevel): KJLogger {
        const isDev = process.env.NODE_ENV !== 'production'

        const root = pino({
            level,
            redact: { paths: REDACT_PATHS, censor: '[redacted]' },
            base: { service: 'kj-supervisor' },
            ...(isDev && {
                transport: {
                    target: 'pino-pretty',
                    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
                },
            }),
        })

        return new KJLogger(root)
    }

    /** Spawn a child logger with extra bindings (e.g. `{ component: 'auth' }`). */
    child(bindings: Record<string, unknown>): KJLogger {
        return new KJLogger(this.pino.child(bindings))
    }

    debug: LogMethod = (objOrMsg, msg) => this.emit('debug', objOrMsg, msg)
    info: LogMethod = (objOrMsg, msg) => this.emit('info', objOrMsg, msg)
    warn: LogMethod = (objOrMsg, msg) => this.emit('warn', objOrMsg, msg)
    error: LogMethod = (objOrMsg, msg) => this.emit('error', objOrMsg, msg)
    fatal: LogMethod = (objOrMsg, msg) => this.emit('fatal', objOrMsg, msg)

    private emit(level: pino.Level, objOrMsg: unknown, msg?: string): void {
        if (typeof objOrMsg === 'string') {
            this.pino[level](objOrMsg)
        } else {
            this.pino[level](objOrMsg as object, msg)
        }
    }
}
