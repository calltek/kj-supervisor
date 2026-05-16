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

export interface KJSettings {
    control_url: string
    provisioning_token: string | null
    agent_token_env: string | null
    config_dir: string
    log_level: 'debug' | 'info' | 'warn' | 'error'
    kj_agent_version: string
}

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])

function requireEnv(name: string): string {
    const value = process.env[name]
    if (!value || value.trim() === '') {
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return value.trim()
}

function optionalEnv(name: string): string | null {
    const value = process.env[name]
    if (!value || value.trim() === '') return null
    return value.trim()
}

function parseUrl(name: string, raw: string): string {
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

export function loadSettings(): KJSettings {
    const control_url = parseUrl('KJ_CONTROL_URL', requireEnv('KJ_CONTROL_URL'))

    const log_level_raw = optionalEnv('KJ_LOG_LEVEL') ?? 'info'
    if (!VALID_LOG_LEVELS.has(log_level_raw)) {
        throw new Error(
            `KJ_LOG_LEVEL must be one of ${[...VALID_LOG_LEVELS].join(', ')}, got: ${log_level_raw}`
        )
    }

    return {
        control_url,
        provisioning_token: optionalEnv('KJ_PROVISIONING_TOKEN'),
        agent_token_env: optionalEnv('KJ_AGENT_TOKEN'),
        config_dir: optionalEnv('KJ_CONFIG_DIR') ?? '/etc/kj-agent',
        log_level: log_level_raw as KJSettings['log_level'],
        kj_agent_version: pkg.version,
    }
}
