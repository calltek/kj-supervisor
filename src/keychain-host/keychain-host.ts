/**
 * The supervisor's side of kj-keychain (kj-agent-base
 * `docs/credenciales-por-referencia.md` §2.1, §7):
 *
 * 1. **Starts it** on every boot — and so after every blue/green, since the new
 *    supervisor boots from scratch: removes whatever `kj-keychain` there is and
 *    creates one from THIS supervisor's image with a fresh control secret that
 *    lives only in this process. A failure here never takes the supervisor down.
 * 2. **One token per agent.** `agent:spawn` puts a fresh one in the container's
 *    env (`envFor`); after a restart of ours there is no state, so the token is
 *    read back from the env of each live container (`adopt`, from `attach`).
 *    kj-keychain learns them over the control channel.
 * 3. **Forwards `resolve`** to the control as `keychain:resolve`, adding the
 *    turn of that session — and only for a session this agent's stream knows.
 *
 * Tokens and resolved values are never logged: agent ids and message types only.
 */

import { randomBytes } from 'node:crypto'

import type { KJLogger } from '../logger'
import {
    KEYCHAIN_RESOLVE_ERROR_CODES,
    type KeychainControlUp,
    type KeychainResolveAck,
    type KeychainResolveErrorCode,
} from '../keychain/control-protocol'
import { type ControlSocketFactory, KeychainControlChannel } from './keychain-control-channel'
import {
    buildKeychainContainerSpec,
    KEYCHAIN_AGENT_ENDPOINT,
    keychainControlUrl,
    LOOPBACK,
} from './keychain-container'
import type Docker from 'dockerode'

export const KEYCHAIN_TOKEN_ENV = 'KJ_KEYCHAIN_TOKEN'
export const KEYCHAIN_ENDPOINT_ENV = 'KJ_KEYCHAIN_ENDPOINT'
/** How long the control gets to answer a `keychain:resolve`. */
export const KEYCHAIN_RESOLVE_TIMEOUT_MS = 8_000

/**
 * `keychain:resolve` (supervisor → control). Local until the control's
 * `protocol.ts` ships it: that file is pulled from production at build time
 * (CLAUDE.md §5), and naming a type the backend hasn't deployed would break CI.
 */
export interface KeychainResolvePayload {
    agent_id: number
    conversation_session_id: string
    turn_id?: string
    turn_request_ids?: string[]
    credential: string
    field: string
}

/** What this module needs from Docker (`KJDocker` implements it). */
export interface KeychainDocker {
    inspectOwnContainer(): Promise<{ image: string; network_mode?: string } | null>
    bridgeGateway(): Promise<string | null>
    isDockerDesktop(): Promise<boolean>
    replaceContainer(spec: Docker.ContainerCreateOptions): Promise<string>
    listKjContainers(): Promise<Array<{ container_id: string; agent_id: number | null }>>
    inspect(container_id: string): Promise<{
        Config?: { Env?: string[] | null } | null
        State?: { Running?: boolean } | null
        NetworkSettings?: {
            IPAddress?: string | null
            Networks?: Record<string, { IPAddress?: string | null } | undefined> | null
        } | null
    }>
}

/**
 * The turn of a session, or null when the session isn't one this agent's
 * stream knows. `AgentStreamManager.keychainTarget` implements it.
 */
export type KeychainSessionLookup = (
    agent_id: number,
    conversation_session_id: string
) => { turn_id?: string; turn_request_ids?: string[] } | null

export interface KeychainHostDeps {
    docker: KeychainDocker
    logger: KJLogger
    sessions: KeychainSessionLookup
    /** `client.emitWithAck('keychain:resolve', …)`. */
    resolve: (payload: KeychainResolvePayload, timeout_ms: number) => Promise<unknown>
    socketFactory?: ControlSocketFactory
}

export class KeychainHost {
    private readonly docker: KeychainDocker
    private readonly logger: KJLogger
    private readonly sessions: KeychainSessionLookup
    private readonly resolveUpstream: KeychainHostDeps['resolve']
    private readonly socketFactory?: ControlSocketFactory
    private readonly tokens = new Map<number, string>()
    private channel: KeychainControlChannel | null = null
    private controlUrl = ''

    constructor(deps: KeychainHostDeps) {
        this.docker = deps.docker
        this.logger = deps.logger.child({ component: 'keychain' })
        this.sessions = deps.sessions
        this.resolveUpstream = deps.resolve
        this.socketFactory = deps.socketFactory
    }

    /** Create kj-keychain and open the control channel. Never throws. */
    async start(): Promise<void> {
        try {
            const own = await this.docker.inspectOwnContainer()
            if (!own) {
                this.logger.warn(
                    'keychain: not running inside a container — kj-keychain not started ' +
                        '(credential references will not work on this supervisor)'
                )
                return
            }
            const gateway = await this.docker.bridgeGateway().catch(() => null)
            const desktop = await this.docker.isDockerDesktop().catch(() => false)
            const agent_host_ip = gateway && !desktop ? gateway : LOOPBACK
            const secret = randomBytes(32).toString('hex')
            const id = await this.docker.replaceContainer(
                buildKeychainContainerSpec({
                    image: own.image,
                    control_secret: secret,
                    agent_host_ip,
                })
            )
            this.logger.info(
                { container_id: id, agent_host_ip, image: own.image },
                'keychain: kj-keychain started'
            )
            await this.adoptLive()
            const refreshUrl = async () => {
                const ip = await this.keychainIp(id)
                this.controlUrl = keychainControlUrl(own.network_mode, ip)
            }
            await refreshUrl()
            this.logger.info({ url: this.controlUrl }, 'keychain: control channel address')
            this.channel = new KeychainControlChannel({
                url: () => this.controlUrl,
                onDisconnect: () => void refreshUrl(),
                secret,
                logger: this.logger,
                onOpen: () => this.sendReset(),
                onMessage: (msg) => void this.onMessage(msg),
                socketFactory: this.socketFactory,
            })
            this.channel.start()
        } catch (err) {
            this.logger.error(
                { err: err instanceof Error ? err.message : String(err) },
                'keychain: could not start kj-keychain — the supervisor carries on without it'
            )
        }
    }

    stop(): void {
        this.channel?.stop()
        this.channel = null
    }

    /**
     * Env for a new agent container: a fresh token (32 bytes, hex) and where
     * kj-keychain is. The token is registered right away.
     */
    envFor(agent_id: number): Record<string, string> {
        const token = randomBytes(32).toString('hex')
        this.register(agent_id, token)
        return { [KEYCHAIN_TOKEN_ENV]: token, [KEYCHAIN_ENDPOINT_ENV]: KEYCHAIN_AGENT_ENDPOINT }
    }

    /**
     * Learn an agent's token from its container's env — after a restart of
     * ours, or a recreate on a new image (which keeps the env). Never throws.
     */
    async adopt(agent_id: number, container_id: string): Promise<void> {
        try {
            const info = await this.docker.inspect(container_id)
            const token = tokenFromEnv(info?.Config?.Env)
            if (token) this.register(agent_id, token)
        } catch (err) {
            this.logger.warn(
                { agent_id, err: err instanceof Error ? err.message : String(err) },
                'keychain: could not read the agent token from its container'
            )
        }
    }

    /** The agent was stopped or deleted: its token stops working. */
    forget(agent_id: number): void {
        if (!this.tokens.delete(agent_id)) return
        this.channel?.send({ type: 'agent:forget', agent_id })
    }

    /** Agent ids with a registered token (for tests and diagnostics; never the tokens). */
    knownAgents(): number[] {
        return [...this.tokens.keys()]
    }

    private register(agent_id: number, token: string): void {
        if (this.tokens.get(agent_id) === token) return
        this.tokens.set(agent_id, token)
        this.channel?.send({ type: 'agent:token', agent_id, token })
    }

    /** kj-keychain's address on the bridge, or null if Docker doesn't say. */
    private async keychainIp(container_id: string): Promise<string | null> {
        try {
            const net = (await this.docker.inspect(container_id)).NetworkSettings
            const ip = net?.Networks?.bridge?.IPAddress || net?.IPAddress
            return ip || null
        } catch {
            return null
        }
    }

    private async adoptLive(): Promise<void> {
        let containers: Array<{ container_id: string; agent_id: number | null }>
        try {
            containers = await this.docker.listKjContainers()
        } catch {
            return
        }
        for (const c of containers) {
            if (c.agent_id == null) continue
            try {
                const info = await this.docker.inspect(c.container_id)
                if (info?.State?.Running !== true) continue
                const token = tokenFromEnv(info.Config?.Env)
                if (token) this.register(c.agent_id, token)
            } catch {
                /* gone meanwhile */
            }
        }
        this.logger.info(
            { agents: this.tokens.size },
            'keychain: tokens recovered from live agents'
        )
    }

    private sendReset(): void {
        this.channel?.send({
            type: 'agents:reset',
            agents: [...this.tokens].map(([agent_id, token]) => ({ agent_id, token })),
        })
    }

    /** Exposed for tests: what happens with one message from kj-keychain. */
    async onMessage(msg: KeychainControlUp): Promise<void> {
        if (msg.type !== 'resolve') return
        const ack = await this.handleResolve(msg)
        // The ack carries the credential's value: it goes down the channel and
        // nowhere else — not even into a debug line.
        this.channel?.send({ type: 'resolve:result', id: msg.id, ack })
    }

    /** Exposed for tests. Decides, and asks the control only when allowed. */
    async handleResolve(msg: KeychainControlUp): Promise<KeychainResolveAck> {
        const log = this.logger.child({
            agent_id: msg.agent_id,
            session_id: msg.conversation_session_id,
        })
        // The agent id comes from kj-keychain, which derived it from the token;
        // the session from the launcher, which checked the calling process
        // (peer-session.ts). That check is what `session_verified` means for
        // MCP calls, so a session known to THIS agent's stream gets its turn.
        // One this agent's stream doesn't know (another agent's, a made-up one,
        // or one with no input since we restarted) never reaches the control.
        const target = this.tokens.has(msg.agent_id)
            ? this.sessions(msg.agent_id, msg.conversation_session_id)
            : null
        if (!target) {
            log.warn('keychain: resolve for a session this agent has not got — refused')
            return {
                ok: false,
                code: 'KEYCHAIN_NO_ACCESS',
                message:
                    'Esta conversación no está activa en el agente, así que no se pueden usar sus ' +
                    'credenciales. Envía un mensaje en la conversación y vuelve a intentarlo.',
            }
        }
        const payload: KeychainResolvePayload = {
            agent_id: msg.agent_id,
            conversation_session_id: msg.conversation_session_id,
            ...(target.turn_id !== undefined
                ? { turn_id: target.turn_id, turn_request_ids: target.turn_request_ids }
                : {}),
            credential: msg.credential,
            field: msg.field,
        }
        let raw: unknown
        try {
            raw = await this.resolveUpstream(payload, KEYCHAIN_RESOLVE_TIMEOUT_MS)
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'keychain: keychain:resolve got no answer from the control'
            )
            return unavailable()
        }
        const ack = asResolveAck(raw)
        if (!ack) {
            log.warn('keychain: malformed keychain:resolve ack from the control')
            return unavailable()
        }
        log.info({ ok: ack.ok, ...(ack.ok ? {} : { code: ack.code }) }, 'keychain: resolved')
        return ack
    }
}

function unavailable(): KeychainResolveAck {
    return {
        ok: false,
        code: 'KEYCHAIN_UNAVAILABLE',
        message:
            'No se ha podido conectar con Kujira para usar esta credencial. Vuelve a intentarlo en un momento.',
    }
}

export function tokenFromEnv(env: string[] | null | undefined): string | null {
    const prefix = `${KEYCHAIN_TOKEN_ENV}=`
    const entry = (env ?? []).find((e) => e.startsWith(prefix))
    const token = entry?.slice(prefix.length)
    return token ? token : null
}

/** Pass on only an ack with the contract's shape; anything else is "unavailable". */
function asResolveAck(raw: unknown): KeychainResolveAck | null {
    if (!raw || typeof raw !== 'object') return null
    const a = raw as Record<string, unknown>
    if (a.ok === true) {
        if (typeof a.value !== 'string' || !Array.isArray(a.sites)) return null
        const sites = a.sites.filter(
            (s): s is { host: string; subdomains: boolean } =>
                !!s &&
                typeof s === 'object' &&
                typeof (s as { host?: unknown }).host === 'string' &&
                typeof (s as { subdomains?: unknown }).subdomains === 'boolean'
        )
        return {
            ok: true,
            value: a.value,
            sites: sites.map((s) => ({ host: s.host, subdomains: s.subdomains })),
        }
    }
    if (a.ok === false) {
        const code = (KEYCHAIN_RESOLVE_ERROR_CODES as readonly string[]).includes(String(a.code))
            ? (a.code as KeychainResolveErrorCode)
            : 'KEYCHAIN_UNAVAILABLE'
        return {
            ok: false,
            code,
            message: typeof a.message === 'string' ? a.message.slice(0, 1000) : '',
        }
    }
    return null
}
