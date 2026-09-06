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
import { markPath, readDecommission, writeDecommission } from './client/auth/decommission'
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
    type AgentInterruptPayload,
    type AgentPausePayload,
    type AgentResumePayload,
    type AgentSkillsChangedPayload,
    type AgentWarmupPayload,
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
    type SupervisorDecommissionPayload,
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

/**
 * The handle that actually holds the process open. See `idleForever`.
 *
 * Module-level so it is a live reference the GC can't collect. Exported only
 * to make that reference unmistakable to a reader — no test asserts on it, and
 * none should: what matters is the behaviour, and that IS covered, by running
 * both cases in real subprocesses (`decommission.test.ts`).
 */
export let idleHandle: ReturnType<typeof setInterval> | undefined

/**
 * Stop every agent container on this machine — stop, not remove (#270).
 *
 * A decommissioned server has no control plane, and by design its socket never
 * opens again: whatever is left running here can never be stopped remotely, is
 * still holding live credentials and still reaching the internet on its own,
 * with nobody watching. "This server must not operate any more" has to mean
 * the work stops too (SOKY review).
 *
 * Volumes, memories and history are untouched — `docker stop` doesn't remove
 * anything. Erasing stays where it belongs: `kujira uninstall`, run on the
 * machine, which says what it destroys before doing it.
 *
 * Never throws: a machine that can't reach its Docker socket still has to end
 * up quiet rather than crash into a restart loop.
 */
async function stopAgents(logger: ReturnType<typeof KJLogger.create>): Promise<void> {
    try {
        const docker = new KJDocker(logger)
        const containers = await docker.listKjContainers()
        if (containers.length === 0) return

        logger.warn({ count: containers.length }, 'parando los agentes de esta máquina')
        for (const c of containers) {
            await docker
                .stopContainer(c.container_id)
                .catch((err) =>
                    logger.error(
                        { container_id: c.container_id, err },
                        'no pude parar este agente; sigo con los demás'
                    )
                )
        }
    } catch (err) {
        logger.error({ err }, 'no pude enumerar los agentes para pararlos')
    }
}

/**
 * Stay up doing nothing, for ever (#270).
 *
 * Not `process.exit()`: the container runs with `--restart unless-stopped`, so
 * exiting is a restart loop — a slower way of knocking at a control that has
 * no server for us. Idling keeps `docker logs` readable (the reason is the
 * last line) and, crucially, never opens the socket again.
 *
 * It has to be a REAL handle. The first version of this returned
 * `new Promise(() => {})`, which reads like it blocks and does not: a pending
 * promise is not an event-loop handle, so with every timer and socket already
 * closed — which is exactly what `decommission()` does right before calling
 * this — node and bun both drain the loop and exit 0 in under a millisecond.
 * The result was the restart loop this whole design exists to avoid, and a
 * container stuck in `Restarting` is indistinguishable from a real crash, so
 * it would have masked genuine failures on that machine (SOKY review).
 *
 * A long interval is a ref'd handle and keeps the loop alive. Kept in a
 * module-level variable so the GC can't take it.
 */
function idleForever(): Promise<never> {
    // ~12 days. Long enough to be free, finite so it stays a normal timer.
    idleHandle = setInterval(() => {}, 1 << 30)
    return new Promise<never>(() => {
        // Never resolves; SIGTERM still stops the container.
    })
}

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

    // Before anything else: were we already told our server is gone? (#270)
    //
    // We do NOT exit here. The container runs with `--restart unless-stopped`,
    // so exiting is a restart loop, and a restart loop is just a slower way of
    // knocking. Staying up and idle costs nothing, keeps `docker logs` useful,
    // and — most importantly — never opens the socket again.
    const alreadyGone = readDecommission(settings.config_dir)
    if (alreadyGone) {
        logger.warn(
            { decommissioned: alreadyGone, marca: markPath(settings.config_dir) },
            'este servidor se borró desde el panel: no trabajo y no me conecto. ' +
                'Si fue un error, borra el fichero de la marca y reinicia el contenedor. ' +
                'Para quitarlo todo de esta máquina (incluidos los datos de los agentes), ' +
                '`kujira uninstall`, que te dirá antes qué borra.'
        )
        // The agents keep their volumes but must not keep WORKING: this
        // machine has no control plane any more, and after this the socket
        // never reopens, so there would be no way to stop them remotely ever
        // again (SOKY review). Stopping is not deleting.
        await stopAgents(logger)
        await idleForever()
        return
    }

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
    const backupHandler = new AgentBackupHandler({
        docker,
        status: statusReporter,
        tracker,
        logger,
    })
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
    // KJ-3: cut the turn in flight. Best-effort: a busy session gets a claude
    // control_request/interrupt on its own stdin; idle/no-stream → a soft error.
    client.onCommand<AgentInterruptPayload, ControlCommandAck>('agent:interrupt', (payload) => {
        const r = streams.interrupt(payload)
        if (r.ok) {
            logger.debug(
                { request_id: payload.request_id, agent_id: payload.agent_id },
                'agent:interrupt delivered'
            )
            return { ok: true, accepted: true }
        }
        return {
            ok: false,
            error: {
                code:
                    r.reason === 'no_stream'
                        ? WS_ERROR_CODES.AGENT_NOT_RUNNING
                        : WS_ERROR_CODES.INTERNAL_ERROR,
                message:
                    r.reason === 'no_stream'
                        ? `agent ${payload.agent_id} has no live stream`
                        : 'failed to write interrupt to agent stdin',
                retryable: false,
            },
        }
    })
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

    // Warm a session before the call starts (llamadas): the control asks for
    // it the moment someone presses "call", so the model/effort swap — which
    // costs a session recycle — happens while the UI rings and the mic is shut,
    // instead of as silence in the middle of the caller's first sentence. Pure
    // passthrough: the wrapper decides whether it needs to respawn, and reports
    // back when it's ready.
    client.onPush<AgentWarmupPayload>('agent:warmup', (payload) => {
        const delivered = streams.writeControl(payload.agent_id, {
            type: 'warmup',
            conversation_session_id: payload.conversation_session_id,
            ...(payload.model ? { model: payload.model } : {}),
            ...(payload.effort ? { effort: payload.effort } : {}),
        })
        logger
            .child({ agent_id: payload.agent_id, component: 'warmup' })
            .info(
                { delivered, session_id: payload.conversation_session_id },
                delivered ? 'warm-up signalled to wrapper' : 'agent not attached — warm-up skipped'
            )
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
                // Y los ficheros `.kj/` si vienen (calltek/kj-backend#642):
                // capacidades, instrucciones, índice de largo plazo. Desde que
                // las instrucciones de producto las renderiza el control y se
                // filtran por las familias de tools del agente, capar una
                // familia o mover un umbral cambia lo que el agente LEE — y
                // hasta ahora eso no llegaba hasta el siguiente stop→start.
                //
                // El purgado se limita a `.kj`, NO a `.claude/memories`: ahí al
                // lado están las memorias que el agente escribe con
                // `memory_write`, y barrerlas en caliente sería borrarle lo
                // suyo para actualizar lo nuestro.
                if (payload.kj_files?.length) {
                    await docker.seedVolumeFiles({
                        volume_name: homeVolume,
                        target_dir: '.claude/memories/.kj',
                        purge: true,
                        files: payload.kj_files.map((f) => ({
                            path: f.path,
                            content: f.content,
                            readonly: f.readonly,
                        })),
                    })
                }
                const delivered = streams.writeControl(payload.agent_id, { type: 'skills_changed' })
                log.info(
                    {
                        skills: payload.skills.length,
                        kj_files: payload.kj_files?.length ?? 0,
                        delivered,
                    },
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

        // Stable identity of this machine, so the control can refuse a second
        // registration of the same box (one machine = one server = one org).
        // Best-effort: if the daemon won't answer we simply don't report it.
        const machine_id = await docker.machineId().catch(() => undefined)

        const payload: ServerHelloPayload = {
            kj_agent_version: settings.kj_agent_version,
            protocol_version: PROTOCOL_VERSION,
            hostname: hostname(),
            ...(machine_id ? { machine_id } : {}),
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
        // The server was deleted from the panel (#270). Terminal on purpose,
        // and handled apart from the other fatals: those exit, and exiting
        // here would be a restart loop that reconnects and gets refused again,
        // for ever. This one is remembered on disk and then goes quiet.
        if (payload.code === WS_ERROR_CODES.SERVER_DECOMMISSIONED) {
            decommission(payload.message ?? 'el servidor se borró desde el panel')
            return
        }

        if (FATAL_ERROR_CODES.has(payload.code)) {
            logger.fatal({ payload }, 'fatal protocol error, exiting')
            stopLoops()
            client.disconnect()
            process.exit(1)
        }
        // Non-fatal codes (e.g. SUPERVISOR_TIMEOUT) are surfaced and we keep going.
        logger.warn({ payload }, 'recoverable protocol error')
    })

    /**
     * Stop for good: remember it on disk, drop every loop, hang up, and idle.
     *
     * Shared by the two ways we can be told — the live push and the handshake
     * refusal — because a supervisor that was connected when its server was
     * deleted and one that was switched off have to end up in the same place.
     */
    function decommission(rawReason: string, server_id?: number): void {
        // The control writes this, and it lands on disk and in the log. Pino
        // logs JSON so there is nothing to inject, but nothing bounds the
        // length either — a truncate keeps a hostile or buggy control from
        // filling the config volume (SOKY review).
        const reason = rawReason.slice(0, 1024)
        const remembered = writeDecommission(settings.config_dir, {
            at: new Date().toISOString(),
            reason,
            server_id,
        })
        logger.warn(
            { reason, server_id, remembered, marca: markPath(settings.config_dir) },
            'este servidor se borró desde el panel: paro los agentes y me quedo quieto. ' +
                'Si fue un error, borra el fichero de la marca y reinicia el contenedor. ' +
                'Para quitarlo todo de esta máquina (incluidos los datos de los agentes), ' +
                '`kujira uninstall`, que te dirá antes qué borra.'
        )
        if (!remembered) {
            // The config volume is read-only or full. We still stop this run;
            // the next boot will be told again by the handshake.
            logger.error('no pude dejar la marca en disco: al reiniciar lo volveré a preguntar')
        }
        stopLoops()
        eventsWatcher.stop()
        streams.detachAll()
        client.disconnect()
        // Stop the work too, not just the supervisor: see `stopAgents`.
        void stopAgents(logger).then(() => idleForever())
    }

    client.onPush<SupervisorDecommissionPayload>('supervisor:decommission', (payload) => {
        // Checking that `payload.server_id` is OURS was asked for in review,
        // and it can't be done today: the supervisor never learns its own id.
        // `server:hello` acks with protocol versions and nothing else, so
        // there is nothing to compare against — a check against `undefined`
        // would be theatre.
        //
        // What does protect this: the message arrives on our own authenticated
        // socket, and the control targets it per server (`notify(server_id)`
        // resolves that server's socket in its tracker). Reaching the wrong
        // machine takes a routing bug in the control, not a forged message —
        // an attacker would need our socket, and with our socket they already
        // have everything.
        //
        // Making it checkable is cheap and worth doing: add `server_id` to
        // `ServerHelloAck`. It needs the backend, so it goes in its own change.
        decommission(payload.reason, payload.server_id)
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
