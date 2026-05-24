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

import { cpus, hostname, platform, release, totalmem } from 'node:os'

import {
    MissingCredentialsError,
    resolveAuth,
    type SupervisorAuth,
    toHandshakeAuth,
    writeAgentTokenToDisk,
} from './client/auth/auth'
import { KJControlClient } from './client/control/control.client'
import { AgentStreamManager } from './agent-stream/stream-manager'
import {
    AGENT_METRICS_INTERVAL_MS,
    KJSettings,
    PING_INTERVAL_MS,
    SERVER_METRICS_INTERVAL_MS,
} from './config/settings'
import { KJDocker } from './docker/client/client'
import { KJDockerEventsWatcher } from './docker/events-watcher/events-watcher'
import { OperationTracker } from './docker/operation-tracker/operation-tracker'
import { AgentInputHandler } from './handlers/agent-input/agent-input.handler'
import { AgentLifecycleHandler } from './handlers/agent-lifecycle/agent-lifecycle.handler'
import { AgentSpawnHandler } from './handlers/agent-spawn/agent-spawn.handler'
import { SupervisorUpgradeHandler } from './handlers/supervisor-upgrade/supervisor-upgrade.handler'
import { KJLogger } from './logger'
import {
    type AgentInputPayload,
    type AgentPausePayload,
    type AgentResumePayload,
    type AgentSpawnPayload,
    type AgentStopPayload,
    type ContainerView,
    type ControlCommandAck,
    PROTOCOL_VERSION,
    type ServerHelloAck,
    type ServerHelloPayload,
    type SupervisorUpgradeRequiredPayload,
    WS_ERROR_CODES,
    type WsErrorPayload,
} from './protocol'
import {
    type AgentMetricsHandle,
    startAgentMetricsLoop,
} from './reporters/agent-metrics/agent-metrics.reporter'
import { AgentStatusReporter } from './reporters/agent-status/agent-status.reporter'
import { type HealthLoopHandle, startHealthLoop } from './reporters/health/health.reporter'
import {
    type ServerMetricsHandle,
    startServerMetricsLoop,
} from './reporters/server-metrics/server-metrics.reporter'

const FATAL_ERROR_CODES: ReadonlySet<string> = new Set([
    WS_ERROR_CODES.AUTH_MISSING,
    WS_ERROR_CODES.AUTH_INVALID,
    WS_ERROR_CODES.PROVISIONING_TOKEN_EXPIRED,
])

async function main(): Promise<void> {
    const settings = KJSettings.load()
    const logger = KJLogger.create(settings.log_level)
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

    // Docker-side pieces. Constructed once at boot — they hold no
    // connection state, so we don't rebuild them per reconnect.
    const docker = new KJDocker(logger)
    const tracker = new OperationTracker()
    const statusReporter = new AgentStatusReporter(client, logger)
    const streams = new AgentStreamManager({ docker, client, logger })
    const eventsWatcher = new KJDockerEventsWatcher({
        docker,
        tracker,
        status: statusReporter,
        streams,
        logger,
    })
    const spawnHandler = new AgentSpawnHandler({
        docker,
        status: statusReporter,
        streams,
        logger,
    })
    const lifecycleHandler = new AgentLifecycleHandler({
        docker,
        tracker,
        status: statusReporter,
        logger,
    })
    const inputHandler = new AgentInputHandler({ streams, logger })
    const upgradeHandler = new SupervisorUpgradeHandler({
        docker,
        logger,
        supervisor_container: settings.supervisor_container,
    })

    void eventsWatcher.start()

    client.onCommand<AgentSpawnPayload, ControlCommandAck>('agent:spawn', (payload) =>
        spawnHandler.handle(payload)
    )
    client.onCommand<AgentStopPayload, ControlCommandAck>('agent:stop', (payload) =>
        lifecycleHandler.handleStop(payload)
    )
    client.onCommand<AgentPausePayload, ControlCommandAck>('agent:pause', (payload) =>
        lifecycleHandler.handlePause(payload)
    )
    client.onCommand<AgentResumePayload, ControlCommandAck>('agent:resume', (payload) =>
        lifecycleHandler.handleResume(payload)
    )
    client.onCommand<AgentInputPayload, ControlCommandAck>('agent:input', (payload) =>
        inputHandler.handle(payload)
    )

    // Push event (not a command), no ack — handler returns void.
    client.onPush<SupervisorUpgradeRequiredPayload>('supervisor:upgrade-required', (payload) => {
        void upgradeHandler.handle(payload)
    })

    let healthHandle: HealthLoopHandle | null = null
    let serverMetricsHandle: ServerMetricsHandle | null = null
    let agentMetricsHandle: AgentMetricsHandle | null = null

    const stopLoops = (): void => {
        healthHandle?.stop()
        serverMetricsHandle?.stop()
        agentMetricsHandle?.stop()
        healthHandle = null
        serverMetricsHandle = null
        agentMetricsHandle = null
    }

    client.on('ready', async () => {
        // A reconnect re-runs this whole handshake; cancel any stale ping loop first.
        stopLoops()

        // Reconciliation: tell the control what kj-agent containers we
        // actually see right now. The control compares against its DB
        // and decides about orphans (kill) and ghosts (mark ERROR).
        let live_containers: ContainerView[] = []
        try {
            const summaries = await docker.listKjContainers()
            live_containers = summaries
                .filter((s): s is { container_id: string; agent_id: number } => s.agent_id != null)
                .map((s) => ({ agent_id: s.agent_id, container_id: s.container_id }))
            logger.info({ count: live_containers.length }, 'reconcile snapshot for server:hello')
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logger.warn(
                { error: message },
                'failed to list containers for reconcile; sending empty list'
            )
        }

        const payload: ServerHelloPayload = {
            kj_agent_version: settings.kj_agent_version,
            protocol_version: PROTOCOL_VERSION,
            hostname: hostname(),
            containers: live_containers,
            // Host specs — let the control persist them so the
            // operator never has to type them on the create form.
            cpu_cores: cpus().length,
            ram_mb: Math.round(totalmem() / 1024 / 1024),
            os: `${platform()} ${release()}`,
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
            serverMetricsHandle = startServerMetricsLoop({
                client,
                logger,
                interval_ms: SERVER_METRICS_INTERVAL_MS,
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
        serverMetricsHandle = startServerMetricsLoop({
            client,
            logger,
            interval_ms: SERVER_METRICS_INTERVAL_MS,
        })
        agentMetricsHandle = startAgentMetricsLoop({
            docker,
            client,
            logger,
            interval_ms: AGENT_METRICS_INTERVAL_MS,
        })
    })

    client.on('protocol_error', (payload: WsErrorPayload) => {
        if (FATAL_ERROR_CODES.has(payload.code)) {
            logger.fatal({ payload }, 'fatal protocol error, exiting')
            stopLoops()
            client.disconnect()
            process.exit(1)
        }
        // Non-fatal codes (e.g. SUPERVISOR_TIMEOUT) are surfaced and we keep going.
        logger.warn({ payload }, 'recoverable protocol error')
    })

    client.on('disconnect', () => {
        stopLoops()
    })

    const shutdown = (signal: string): void => {
        logger.info({ signal }, 'received shutdown signal')
        stopLoops()
        eventsWatcher.stop()
        streams.detachAll()
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
