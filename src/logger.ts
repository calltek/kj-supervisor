/**
 * Structured logger. Pino in production (stdout, picked up by Docker),
 * pino-pretty in development for readability. Tokens are redacted at
 * the serializer level so we never leak them in logs.
 */

import pino from 'pino'

export type KJLogger = pino.Logger

const REDACT_PATHS = [
    'auth.provisioning_token',
    'auth.agent_token',
    'ack.agent_token',
    'provisioning_token',
    'agent_token',
    '*.provisioning_token',
    '*.agent_token',
]

export function createLogger(level: pino.LevelWithSilent): KJLogger {
    const isDev = process.env.NODE_ENV !== 'production'

    return pino({
        level,
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        base: { service: 'kj-agent' },
        ...(isDev && {
            transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
        }),
    })
}
