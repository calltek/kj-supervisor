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
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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

export function markPath(config_dir: string): string {
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
        //
        // Fail-closed has a cost worth naming: anyone who can write to
        // `config_dir` can shut this supervisor down for good with a `touch`.
        // That directory must stay root-only and must never be mounted into an
        // agent container. The way back is in the log — delete the file and
        // restart — precisely so this is recoverable without an `uninstall`.
        return { at: 'unknown', reason: 'marca ilegible en disco' }
    }
}

/**
 * Write the mark. Best-effort: if the config volume is read-only we still stop
 * this run — losing the mark only costs a restart that stops again.
 *
 * Atomic (temp + rename) because a truncated write would read back as a
 * corrupt mark, and a corrupt mark counts as a mark: our own interrupted write
 * would silently become a permanent shutdown with no reason recorded. Rename
 * within the same directory is atomic, so the file is either the old one or
 * the whole new one, never half of either.
 */
export function writeDecommission(config_dir: string, mark: DecommissionMark): boolean {
    const target = markPath(config_dir)
    const temp = `${target}.tmp`
    try {
        writeFileSync(temp, JSON.stringify(mark, null, 2), { mode: 0o600 })
        renameSync(temp, target)
        return true
    } catch {
        try {
            unlinkSync(temp)
        } catch {
            // Nothing to clean up, or we can't. Either way the target is
            // untouched, which is the point.
        }
        return false
    }
}
