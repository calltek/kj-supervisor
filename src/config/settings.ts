/**
 * Environment variables, validated at boot. Throws if anything required
 * is missing or malformed. Token resolution lives in `client/auth.ts` —
 * this module only exposes raw env values.
 */

import pkg from '../../package.json' with { type: 'json' }

/**
 * Health:ping cadence. Hardcoded rather than env-configurable so the
 * control's last_seen_at timeout has a predictable budget regardless
 * of which supervisor binary is connected.
 */
export const PING_INTERVAL_MS = 30_000

export type KJLogLevel = 'debug' | 'info' | 'warn' | 'error'

const VALID_LOG_LEVELS: ReadonlySet<KJLogLevel> = new Set(['debug', 'info', 'warn', 'error'])

export class KJSettings {
    readonly control_url: string
    readonly provisioning_token: string | null
    readonly agent_token_env: string | null
    readonly config_dir: string
    readonly log_level: KJLogLevel
    readonly kj_agent_version: string

    private constructor(values: {
        control_url: string
        provisioning_token: string | null
        agent_token_env: string | null
        config_dir: string
        log_level: KJLogLevel
        kj_agent_version: string
    }) {
        this.control_url = values.control_url
        this.provisioning_token = values.provisioning_token
        this.agent_token_env = values.agent_token_env
        this.config_dir = values.config_dir
        this.log_level = values.log_level
        this.kj_agent_version = values.kj_agent_version
    }

    /**
     * Load and validate from process.env. Throws on missing or
     * malformed required values.
     */
    static load(): KJSettings {
        const control_url = KJSettings.parseUrl(
            'KJ_CONTROL_URL',
            KJSettings.requireEnv('KJ_CONTROL_URL')
        )

        const log_level_raw = KJSettings.optionalEnv('KJ_LOG_LEVEL') ?? 'info'
        if (!VALID_LOG_LEVELS.has(log_level_raw as KJLogLevel)) {
            throw new Error(
                `KJ_LOG_LEVEL must be one of ${[...VALID_LOG_LEVELS].join(', ')}, got: ${log_level_raw}`
            )
        }

        return new KJSettings({
            control_url,
            provisioning_token: KJSettings.optionalEnv('KJ_PROVISIONING_TOKEN'),
            agent_token_env: KJSettings.optionalEnv('KJ_AGENT_TOKEN'),
            config_dir: KJSettings.optionalEnv('KJ_CONFIG_DIR') ?? '/etc/kj-agent',
            log_level: log_level_raw as KJLogLevel,
            kj_agent_version: pkg.version,
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

    private static parseUrl(name: string, raw: string): string {
        let parsed: URL
        try {
            parsed = new URL(raw)
        } catch {
            throw new Error(`${name} is not a valid URL: ${raw}`)
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`${name} must use http(s), got: ${parsed.protocol}`)
        }
        // Drop trailing slash so callers can append paths predictably.
        return raw.replace(/\/+$/, '')
    }
}
