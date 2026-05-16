/**
 * Supervisor entry point.
 *
 * Wires together: settings → auth resolution → control client →
 * handshake (server:hello) → token persistence → health ping loop.
 *
 * Reconnection is handled by Socket.IO under the hood; we re-run the
 * handshake every time `ready` fires so the post-reconnect path is
 * identical to the cold-boot path.
 */

import { hostname } from 'node:os'

import {
    MissingCredentialsError,
    resolveAuth,
    type SupervisorAuth,
    toHandshakeAuth,
    writeAgentTokenToDisk,
} from './client/auth'
import { KJControlClient } from './client/control.client'
import { loadSettings, PING_INTERVAL_MS } from './config/settings'
import { createLogger } from './logger'
import {
    PROTOCOL_VERSION,
    type ServerHelloAck,
    type ServerHelloPayload,
    type WsErrorPayload,
} from './protocol'
import { type HealthLoopHandle, startHealthLoop } from './reporters/health.reporter'

const FATAL_ERROR_CODES = new Set(['AUTH_MISSING', 'AUTH_INVALID', 'PROVISIONING_TOKEN_EXPIRED'])

async function main(): Promise<void> {
    const settings = loadSettings()
    const logger = createLogger(settings.log_level)
    logger.info(
        {
            control_url: settings.control_url,
            config_dir: settings.config_dir,
            kj_agent_version: settings.kj_agent_version,
            protocol_version: PROTOCOL_VERSION,
        },
        'supervisor starting'
    )

    let auth: SupervisorAuth
    try {
        auth = resolveAuth({
            config_dir: settings.config_dir,
            provisioning_token: settings.provisioning_token,
            agent_token_env: settings.agent_token_env,
        })
    } catch (err) {
        if (err instanceof MissingCredentialsError) {
            logger.error(err.message)
            process.exit(1)
        }
        throw err
    }

    logger.info({ mode: auth.mode }, 'auth resolved')

    const client = new KJControlClient({
        url: settings.control_url,
        auth: toHandshakeAuth(auth),
        logger,
    })

    let healthHandle: HealthLoopHandle | null = null
    const stopHealthLoop = (): void => {
        if (healthHandle) {
            healthHandle.stop()
            healthHandle = null
        }
    }

    client.on('ready', async () => {
        // A reconnect re-runs this whole handshake; cancel any stale ping loop first.
        stopHealthLoop()

        const payload: ServerHelloPayload = {
            kj_agent_version: settings.kj_agent_version,
            protocol_version: PROTOCOL_VERSION,
            hostname: hostname(),
            // Hito 5 lo poblará con `docker ps --filter "label=kj-agent" -q`.
            containers: [],
        }

        let ack: ServerHelloAck
        try {
            ack = await client.emitWithAck<ServerHelloAck>('server:hello', payload, 5000)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logger.error({ error: message }, 'server:hello ack failed; will retry on reconnect')
            return
        }

        if (ack.accepted === 'degraded') {
            logger.warn(
                {
                    protocol_version_control: ack.protocol_version_control,
                    protocol_version_supervisor: ack.protocol_version_supervisor,
                    error: ack.error,
                },
                'protocol degraded — only immutable events will flow until supervisor:upgrade-required'
            )
            // Keep the connection alive: immutable events still flow.
            healthHandle = startHealthLoop({
                client,
                logger,
                interval_ms: PING_INTERVAL_MS,
            })
            return
        }

        if (ack.accepted !== true) {
            logger.error({ ack }, 'server:hello rejected')
            return
        }

        if (ack.agent_token) {
            try {
                writeAgentTokenToDisk(settings.config_dir, ack.agent_token)
                logger.info('agent_token persisted to disk')
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                logger.error(
                    { error: message },
                    'failed to persist agent_token — supervisor will not survive a restart'
                )
            }
            // Future reconnects must use the agent_token, not the now-consumed provisioning_token.
            client.setAuth({ agent_token: ack.agent_token })
        }

        logger.info({ protocol_version: ack.protocol_version }, 'handshake complete')

        healthHandle = startHealthLoop({
            client,
            logger,
            interval_ms: PING_INTERVAL_MS,
        })
    })

    client.on('protocol_error', (payload: WsErrorPayload) => {
        if (FATAL_ERROR_CODES.has(payload.code)) {
            logger.fatal({ payload }, 'fatal protocol error, exiting')
            stopHealthLoop()
            client.disconnect()
            process.exit(1)
        }
        // Non-fatal codes (e.g. SUPERVISOR_TIMEOUT) are surfaced and we keep going.
        logger.warn({ payload }, 'recoverable protocol error')
    })

    client.on('disconnect', () => {
        stopHealthLoop()
    })

    const shutdown = (signal: string): void => {
        logger.info({ signal }, 'received shutdown signal')
        stopHealthLoop()
        client.disconnect()
        process.exit(0)
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

    client.connect()
}

main().catch((err) => {
    console.error('supervisor crashed:', err)
    process.exit(1)
})
