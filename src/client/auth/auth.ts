/**
 * Reads the supervisor's persistent `agent_token` from disk.
 *
 * The token is written exactly once by `install.sh`, which exchanges
 * the operator's provisioning_token for an agent_token over HTTP
 * (POST /provisioning/bundle) at install time. The supervisor itself
 * never mints, rotates or accepts a new token at runtime — if it
 * can't read one from `<config_dir>/token`, it exits.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_FILE = 'token'

export class MissingAgentTokenError extends Error {
    constructor(token_path: string) {
        super(
            `No agent_token at ${token_path}. Re-run the install script to provision this supervisor.`
        )
        this.name = 'MissingAgentTokenError'
    }
}

function tokenPath(config_dir: string): string {
    return join(config_dir, TOKEN_FILE)
}

/**
 * Read `<config_dir>/token`, trimmed. Returns null on ENOENT or empty
 * file; other errors propagate.
 */
export function readAgentTokenFromDisk(config_dir: string): string | null {
    try {
        const raw = readFileSync(tokenPath(config_dir), 'utf8').trim()
        return raw === '' ? null : raw
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
    }
}

/**
 * Load the agent_token from disk or throw. Wraps `readAgentTokenFromDisk`
 * with the canonical "missing credentials" error so `main.ts` has a
 * single failure path.
 */
export function loadAgentToken(config_dir: string): string {
    const token = readAgentTokenFromDisk(config_dir)
    if (!token) {
        throw new MissingAgentTokenError(tokenPath(config_dir))
    }
    return token
}
