/**
 * The mark that says this machine's server was deleted from the panel (#270).
 *
 * Why a file on disk and not just exiting: the supervisor container runs with
 * `--restart unless-stopped`, so `process.exit()` is not a way to stop — Docker
 * brings it straight back, for ever, and we are back to a machine knocking at
 * a control that no longer has a server for it. The mark survives the restart
 * and is the first thing boot looks at.
 *
 * What it deliberately does NOT do is erase anything. The agents' volumes hold
 * memories, files and history, and `kujira uninstall` — which asks first and
 * lists what it destroys — is where that decision belongs. This only stops the
 * work and leaves a note saying why.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARK_FILE = 'decommissioned'

export interface DecommissionMark {
    /** ISO timestamp of when the control told us. */
    at: string
    /** What the control said, in the operator's language. */
    reason: string
    /** The server id we used to be, for reading old logs. */
    server_id?: number
}

function markPath(config_dir: string): string {
    return join(config_dir, MARK_FILE)
}

/** Has this machine already been told its server is gone? */
export function readDecommission(config_dir: string): DecommissionMark | null {
    const path = markPath(config_dir)
    if (!existsSync(path)) return null
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as DecommissionMark
    } catch {
        // Unreadable or truncated: treat it as marked anyway. A corrupt mark
        // means SOMETHING wrote it, and the safe reading of "maybe you were
        // decommissioned" is to stay quiet rather than resume knocking.
        return { at: 'unknown', reason: 'marca ilegible en disco' }
    }
}

/**
 * Write the mark. Best-effort: if the config volume is read-only we still stop
 * this run — losing the mark only costs a restart that stops again.
 */
export function writeDecommission(config_dir: string, mark: DecommissionMark): boolean {
    try {
        writeFileSync(markPath(config_dir), JSON.stringify(mark, null, 2), { mode: 0o600 })
        return true
    } catch {
        return false
    }
}
