/**
 * Token I/O and credential resolution for the supervisor.
 *
 * The agent_token persists across reboots in `<config_dir>/token`
 * (mode 0600). It is written exactly once — when the control mints it
 * in the first server:hello ack — so reading/writing has to be careful
 * about atomicity and permissions.
 */

import {
    chmodSync,
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const TOKEN_FILE = 'token'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export type SupervisorAuth =
    | { mode: 'provisioning'; provisioning_token: string }
    | { mode: 'agent'; agent_token: string }

export class MissingCredentialsError extends Error {
    constructor() {
        super(
            'No supervisor credentials available. Provide KJ_PROVISIONING_TOKEN or KJ_AGENT_TOKEN, ' +
                'or persist a token at <KJ_CONFIG_DIR>/token.'
        )
        this.name = 'MissingCredentialsError'
    }
}

function tokenPath(config_dir: string): string {
    return join(config_dir, TOKEN_FILE)
}

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
 * Write `<config_dir>/token` atomically with mode 0600. We write to a
 * tmp file, fsync, chmod, then rename — so an interrupted call never
 * leaves a half-written or world-readable file behind.
 */
export function writeAgentTokenToDisk(config_dir: string, token: string): void {
    if (!token || token.trim() === '') {
        throw new Error('Refusing to write empty agent token to disk')
    }
    mkdirSync(config_dir, { recursive: true, mode: DIR_MODE })

    const finalPath = tokenPath(config_dir)
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`

    const fd = openSync(tmpPath, 'w', FILE_MODE)
    try {
        writeSync(fd, token)
        fsyncSync(fd)
    } finally {
        closeSync(fd)
    }

    try {
        chmodSync(tmpPath, FILE_MODE)
        renameSync(tmpPath, finalPath)
    } catch (err) {
        try {
            unlinkSync(tmpPath)
        } catch {
            // best-effort cleanup
        }
        throw err
    }

    // Ensure the directory entry hits disk so a power loss doesn't lose the rename.
    try {
        const dirFd = openSync(dirname(finalPath), 'r')
        try {
            fsyncSync(dirFd)
        } finally {
            closeSync(dirFd)
        }
    } catch {
        // Some filesystems (e.g. tmpfs on macOS in tests) reject fsync on dirs. Non-fatal.
    }
}

/**
 * Resolve which credential to send in the Socket.IO handshake.
 *
 * Priority:
 *   1. KJ_AGENT_TOKEN env override (dev convenience).
 *   2. Token persisted at <config_dir>/token (normal operation).
 *   3. KJ_PROVISIONING_TOKEN env (first-time bootstrap).
 *
 * The agent_token wins over the provisioning_token when both are
 * available so a restart after first handshake reconnects cleanly
 * instead of accidentally re-using a now-consumed provisioning token.
 */
export function resolveAuth(input: {
    config_dir: string
    provisioning_token: string | null
    agent_token_env: string | null
}): SupervisorAuth {
    if (input.agent_token_env) {
        return { mode: 'agent', agent_token: input.agent_token_env }
    }
    const fromDisk = readAgentTokenFromDisk(input.config_dir)
    if (fromDisk) {
        return { mode: 'agent', agent_token: fromDisk }
    }
    if (input.provisioning_token) {
        return { mode: 'provisioning', provisioning_token: input.provisioning_token }
    }
    throw new MissingCredentialsError()
}

/**
 * Shape the auth object the way the control expects on `socket.handshake.auth`.
 */
export function toHandshakeAuth(auth: SupervisorAuth): Record<string, string> {
    return auth.mode === 'agent'
        ? { agent_token: auth.agent_token }
        : { provisioning_token: auth.provisioning_token }
}
