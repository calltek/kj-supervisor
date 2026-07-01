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

import { MissingAgentTokenError, loadAgentToken } from './client/auth/auth'
import { KJControlClient } from './client/control/control.client'
import { McpDispatcher, type McpEnvelope } from './agent-stream/mcp-dispatcher'
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
import { AgentExecHandler } from './handlers/agent-exec/agent-exec.handler'
import { AgentBackupHandler } from './handlers/agent-backup/agent-backup.handler'
import { AgentImageUpdateHandler } from './handlers/agent-image-update/agent-image-update.handler'
import { AgentInputHandler } from './handlers/agent-input/agent-input.handler'
import { AgentLifecycleHandler } from './handlers/agent-lifecycle/agent-lifecycle.handler'
import { AgentSpawnHandler } from './handlers/agent-spawn/agent-spawn.handler'
import { AgentSyncHandler } from './handlers/agent-sync/agent-sync.handler'
import { OAuthExchangeHandler } from './handlers/oauth-exchange/oauth-exchange.handler'
import { SupervisorUpgradeHandler } from './handlers/supervisor-upgrade/supervisor-upgrade.handler'
import { KJLogger } from './logger'
import {
    type AgentBackupAck,
    type AgentBackupPayload,
    type AgentDeletePayload,
    type AgentExecAck,
    type AgentExecPayload,
    type AgentImageUpdatePayload,
    type AgentRestoreAck,
    type AgentRestorePayload,
    type AgentInputPayload,
    type AgentPausePayload,
    type AgentResumePayload,
    type AgentSkillsChangedPayload,
    type AgentSpawnPayload,
    type AgentStopPayload,
    type AgentSyncPayload,
    type ContainerView,
    type ControlCommandAck,
    type McpRequestAck,
    type McpRequestPayload,
    type OAuthExchangeAck,
    type OAuthExchangePayload,
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

    let agent_token: string
    try {
        agent_token = loadAgentToken(settings.config_dir)
    } catch (err) {
        if (err instanceof MissingAgentTokenError) {
            logger.error(err.message)
            process.exit(1)
        }
        throw err
    }

    logger.info('agent_token loaded from disk')

    const client = new KJControlClient({
        url: settings.control_url,
        auth: { agent_token },
        logger,
    })

    // Docker-side pieces. Constructed once at boot — they hold no
    // connection state, so we don't rebuild them per reconnect.
    const docker = new KJDocker(logger)
    const tracker = new OperationTracker()
    const statusReporter = new AgentStatusReporter(client, logger)

    // kj-mcp wiring: the dispatcher relays MCP traffic in both
    // directions. Stream manager and dispatcher reference each other
    // (manager hands incoming lines to dispatcher; dispatcher writes
    // responses back via manager.writeMcp), so we declare the manager
    // first and let the dispatcher close over it.
    let streams: AgentStreamManager
    const mcp = new McpDispatcher({
        sendRequest: (agent_id, request_id, tool, args, target) =>
            client.emitWithAck<McpRequestAck>(
                'mcp:request',
                {
                    request_id,
                    agent_id,
                    tool: tool as McpRequestPayload['tool'],
                    args,
                    ...(target.conversation_id !== undefined
                        ? { conversation_id: target.conversation_id }
                        : {}),
                    ...(target.contact_id !== undefined ? { contact_id: target.contact_id } : {}),
                    // The container's raw session stamp — the control resolves
                    // the conversation from it against the DB (KJ-27: strict,
                    // origin-agnostic filtering, no in-memory-map guessing).
                    ...(target.conversation_session_id !== undefined
                        ? { conversation_session_id: target.conversation_session_id }
                        : {}),
                },
                15000
            ),
        writeToContainer: (agent_id: number, envelope: McpEnvelope) =>
            streams.writeMcp(agent_id, envelope),
        resolveTarget: (agent_id: number, conversation_session_id: string | undefined) =>
            streams.resolveTarget(agent_id, conversation_session_id),
        logger,
    })
    streams = new AgentStreamManager({ docker, client, logger, mcp })
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
    const imageUpdateHandler = new AgentImageUpdateHandler({
        docker,
        status: statusReporter,
        streams,
        tracker,
        logger,
    })
    const inputHandler = new AgentInputHandler({ streams, logger })
    const execHandler = new AgentExecHandler({ docker, logger })
    const syncHandler = new AgentSyncHandler({ streams, logger })
    const backupHandler = new AgentBackupHandler({ docker, status: statusReporter, logger })
    const oauthExchangeHandler = new OAuthExchangeHandler({ logger })
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
    client.onCommand<AgentDeletePayload, ControlCommandAck>('agent:delete', (payload) =>
        lifecycleHandler.handleDelete(payload)
    )
    client.onCommand<AgentImageUpdatePayload, ControlCommandAck>('agent:image:update', (payload) =>
        imageUpdateHandler.handle(payload)
    )
    client.onCommand<AgentInputPayload, ControlCommandAck>('agent:input', (payload) =>
        inputHandler.handle(payload)
    )
    client.onCommand<AgentExecPayload, AgentExecAck>('agent:exec', (payload) =>
        execHandler.handle(payload)
    )
    client.onCommand<AgentSyncPayload, ControlCommandAck>('agent:sync', (payload) =>
        syncHandler.handle(payload)
    )
    client.onCommand<AgentBackupPayload, AgentBackupAck>('agent:backup', (payload) =>
        backupHandler.handleBackup(payload)
    )
    client.onCommand<AgentRestorePayload, AgentRestoreAck>('agent:restore', (payload) =>
        backupHandler.handleRestore(payload)
    )
    client.onCommand<OAuthExchangePayload, OAuthExchangeAck>('oauth:exchange', (payload) =>
        oauthExchangeHandler.handle(payload)
    )

    // Push event (not a command), no ack — handler returns void.
    client.onPush<SupervisorUpgradeRequiredPayload>('supervisor:upgrade-required', (payload) => {
        void upgradeHandler.handle(payload)
    })

    // Skills hot-reload: the operator (re)assigned/edited a skill on a
    // RUNNING agent. Re-seed `.claude/skills/` on the volume (purge +
    // rewrite, exactly like spawn) then tell the wrapper to recycle its
    // claude pool. No container restart, no conversation loss; busy
    // sessions finish their turn first (wrapper-side). Best-effort: if
    // the agent isn't running locally, the next spawn seeds it anyway.
    client.onPush<AgentSkillsChangedPayload>('agent:skills_changed', (payload) => {
        void (async () => {
            const log = logger.child({ agent_id: payload.agent_id, component: 'skills-changed' })
            try {
                const homeVolume = `kj-agent-${payload.agent_id}-home`
                await docker.ensureVolumeOwnership(homeVolume)
                await docker.seedVolumeFiles({
                    volume_name: homeVolume,
                    target_dir: '.claude/skills',
                    purge: true,
                    files: payload.skills.map((s) => ({
                        path: s.path,
                        content: s.content,
                        readonly: true,
                    })),
                })
                const delivered = streams.writeControl(payload.agent_id, { type: 'skills_changed' })
                log.info(
                    { skills: payload.skills.length, delivered },
                    'skills re-seeded; pool recycle signalled to wrapper'
                )
            } catch (err) {
                log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'skills hot-reload failed — next spawn will seed the fresh set'
                )
            }
        })()
    })

    // NOTE: the `memory:updated` and `contact_profile:updated` pushes
    // were removed 2026-06-03. Both were log-only end-to-end (the
    // in-container MCP advertises only `tools`, so Claude Code never
    // consumed the resource notification they were meant to drive). The
    // backend no longer emits them — the "operator edited your memory/
    // notes, re-read them" signal is now a persisted SYSTEM message it
    // prepends as a <system-reminder> to the next real agent:input.
    // Volume re-seed still rides on the spawn payload + sync flow.
    // `forwardPushToContainer` stays on McpDispatcher for any future
    // push topic but has no caller today.

    let healthHandle: HealthLoopHandle | null = null
    let serverMetricsHandle: ServerMetricsHandle | null = null
    let agentMetricsHandle: AgentMetricsHandle | null = null
    // Blue/green self-upgrade: a fresh clone (`kj-supervisor-new-*`) finishes
    // the swap on its first handshake (remove the old + rename to canonical).
    // Runs at most once; until it succeeds we retry on each handshake.
    let blueGreenSwapDone = false

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

        logger.info({ protocol_version: ack.protocol_version }, 'handshake complete')

        // Blue/green self-upgrade completion: if we're the fresh clone (our
        // container name differs from the canonical KJ_SUPERVISOR_CONTAINER),
        // now that we've handshaked (so the control's tracker points at US),
        // force-remove the old container and rename ourselves to the canonical
        // name. Done BEFORE agent:sync attaches, so there's no double-attach.
        if (!blueGreenSwapDone) {
            const canonical = settings.supervisor_container
            if (!canonical) {
                blueGreenSwapDone = true // can't be a clone without it
            } else {
                let ownName: string | null = null
                try {
                    ownName = await docker.getOwnContainerName()
                } catch {
                    ownName = null
                }
                if (!ownName || ownName === canonical) {
                    logger.info(
                        { own: ownName, canonical },
                        'not an upgrade clone (own name absent or already canonical) — no swap'
                    )
                    blueGreenSwapDone = true // not a clone / already canonical
                } else if (!(await docker.containerExists(ownName))) {
                    // KJ_OWN_CONTAINER is stale: we already completed a swap and
                    // were renamed to `canonical`, but the env still holds the old
                    // temp name. Swapping again would force-remove ourselves.
                    logger.info(
                        { own: ownName, canonical },
                        'stale own-name (already swapped to canonical) — no swap'
                    )
                    blueGreenSwapDone = true
                } else {
                    try {
                        logger.info(
                            { own: ownName, canonical },
                            'upgrade clone handshaked — completing blue/green swap'
                        )
                        await docker.removeContainer(canonical) // force-remove old (no revival)
                        await docker.renameContainer(ownName, canonical) // become canonical
                        blueGreenSwapDone = true
                        logger.info('blue/green swap complete — now the canonical supervisor')
                    } catch (err) {
                        logger.error(
                            { err: err instanceof Error ? err.message : String(err) },
                            'blue/green swap failed; will retry on next handshake'
                        )
                    }
                }
            }
        }

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
