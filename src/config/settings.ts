/**
 * Environment variables, validated at boot. Throws if anything required
 * is missing or malformed. The persistent `agent_token` is NOT an env
 * var — it lives on disk at `<config_dir>/token`, written by the
 * install script. See `client/auth/auth.ts`.
 */

import pkg from '../../package.json' with { type: 'json' }

/**
 * Health:ping cadence. Hardcoded rather than env-configurable so the
 * control's last_seen_at timeout has a predictable budget regardless
 * of which supervisor binary is connected.
 */
export const PING_INTERVAL_MS = 30_000

/** server:metrics cadence — load avg + uptime of the host VPS. 15s so the
 * panel's CPU/RAM/load feels live (the WS push is instant; this is the source
 * cadence). A short sampling window also clears transient spikes faster. */
export const SERVER_METRICS_INTERVAL_MS = 15_000

/** agent:metrics cadence — uptime + tokens/cost per running agent. */
export const AGENT_METRICS_INTERVAL_MS = 60_000

export type KJLogLevel = 'debug' | 'info' | 'warn' | 'error'

const VALID_LOG_LEVELS: ReadonlySet<KJLogLevel> = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Hosts where plain http to the control is accepted without an explicit
 * opt-in: loopback, `*.localhost`, and the Docker Desktop alias a dev
 * container uses to reach the host's control.
 */
function isDevHost(hostname: string): boolean {
    return (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname === 'host.docker.internal'
    )
}

export class KJSettings {
    readonly control_url: string
    readonly config_dir: string
    readonly log_level: KJLogLevel
    readonly kj_agent_version: string
    /** Revision and build time baked into this image; null on a local build. */
    readonly image_revision: string | null
    readonly image_built_at: string | null
    /**
     * Name of THIS supervisor's own Docker container. Only set when
     * running inside Docker; needed for the blue/green self-upgrade
     * (we use dockerode to clone our own spec with a new image tag,
     * and we need our own name to find ourselves).
     */
    readonly supervisor_container: string | null

    private constructor(values: {
        control_url: string
        config_dir: string
        log_level: KJLogLevel
        kj_agent_version: string
        image_revision: string | null
        image_built_at: string | null
        supervisor_container: string | null
    }) {
        this.control_url = values.control_url
        this.config_dir = values.config_dir
        this.log_level = values.log_level
        this.kj_agent_version = values.kj_agent_version
        this.image_revision = values.image_revision
        this.image_built_at = values.image_built_at
        this.supervisor_container = values.supervisor_container
    }

    /**
     * Load and validate from process.env. Throws on missing or
     * malformed required values.
     */
    static load(): KJSettings {
        const control_url = KJSettings.parseUrl(
            'KJ_CONTROL_URL',
            KJSettings.requireEnv('KJ_CONTROL_URL'),
            KJSettings.optionalEnv('KJ_ALLOW_INSECURE_CONTROL') === '1'
        )

        const log_level_raw = KJSettings.optionalEnv('KJ_LOG_LEVEL') ?? 'info'
        if (!VALID_LOG_LEVELS.has(log_level_raw as KJLogLevel)) {
            throw new Error(
                `KJ_LOG_LEVEL must be one of ${[...VALID_LOG_LEVELS].join(', ')}, got: ${log_level_raw}`
            )
        }

        return new KJSettings({
            control_url,
            config_dir: KJSettings.optionalEnv('KJ_CONFIG_DIR') ?? '/etc/kj-supervisor',
            log_level: log_level_raw as KJLogLevel,
            kj_agent_version: pkg.version,
            image_revision: KJSettings.optionalEnv('KJ_BUILD_REVISION'),
            image_built_at: KJSettings.optionalEnv('KJ_BUILT_AT'),
            supervisor_container: KJSettings.optionalEnv('KJ_SUPERVISOR_CONTAINER'),
        })
    }

    private static requireEnv(name: string): string {
        const value = process.env[name]
        if (!value || value.trim() === '') {
            throw new Error(`Missing required environment variable: ${name}`)
        }
        return value.trim()
    }

    private static optionalEnv(name: string): string | null {
        const value = process.env[name]
        if (!value || value.trim() === '') return null
        return value.trim()
    }

    private static parseUrl(name: string, raw: string, allow_insecure = false): string {
        let parsed: URL
        try {
            parsed = new URL(raw)
        } catch {
            throw new Error(`${name} is not a valid URL: ${raw}`)
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`${name} must use http(s), got: ${parsed.protocol}`)
        }
        // Over plain http anyone on the network path can impersonate the
        // control and send agent:spawn / agent:exec to this host.
        if (parsed.protocol === 'http:' && !allow_insecure && !isDevHost(parsed.hostname)) {
            throw new Error(
                `${name} must use https:// (got ${raw}): over plain http anyone on the ` +
                    'network path could impersonate the control plane and run commands on ' +
                    'this server. Use https://api.kujira.so. For a development control on a ' +
                    'non-local host only, set KJ_ALLOW_INSECURE_CONTROL=1 (never in production).'
            )
        }
        // Drop trailing slash so callers can append paths predictably.
        return raw.replace(/\/+$/, '')
    }
}
