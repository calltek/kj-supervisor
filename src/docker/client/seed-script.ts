const SAFE_CHARS = /^[A-Za-z0-9._/-]+$/

/** Single-quote a value for `sh`: `'` becomes `'\''`. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Reject anything that could leave `/v/<target_dir>` or reach the shell as
 * something other than a plain relative path. The control validates names too,
 * but the helper runs as root over the whole agent volume, so this check must
 * not depend on another repo's regex.
 */
function assertSafeRelativePath(value: string, label: string, allowDot: boolean): void {
    if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`)
    if (!SAFE_CHARS.test(value)) throw new Error(`${label} has characters outside [A-Za-z0-9._/-]`)
    if (value.startsWith('/')) throw new Error(`${label} must be relative`)
    for (const segment of value.split('/')) {
        if (segment === '' || segment === '..' || (segment === '.' && !allowDot)) {
            throw new Error(`${label} has an invalid segment`)
        }
    }
}

/** Trailing slashes are tolerated on the directory; everything else is checked. */
export function normalizeTargetDir(targetDir: string): string {
    const dir = targetDir.replace(/\/+$/, '')
    assertSafeRelativePath(dir, 'seed target_dir', true)
    return dir
}

export function buildSeedScript(opts: {
    target_dir: string
    files: ReadonlyArray<{ path: string; content: string; readonly?: boolean }>
    purge?: boolean
}): { script: string; targetDir: string } {
    const targetDir = normalizeTargetDir(opts.target_dir)
    // Validate everything before emitting a single line of script.
    for (const f of opts.files) assertSafeRelativePath(f.path, 'seed file path', false)

    const root = shellQuote(`/v/${targetDir}`)
    const lines: string[] = ['set -e', `mkdir -p ${root}`]
    if (opts.purge) {
        // Wipe contents but keep the directory so its ownership stays intact.
        lines.push(`find ${root} -mindepth 1 -delete`)
    }
    for (const f of opts.files) {
        // Paths may nest (`comercial/oferta.md`): create the parents first.
        const full = shellQuote(`/v/${targetDir}/${f.path}`)
        const slash = f.path.lastIndexOf('/')
        if (slash !== -1) {
            lines.push(`mkdir -p ${shellQuote(`/v/${targetDir}/${f.path.slice(0, slash)}`)}`)
        }
        const b64 = Buffer.from(f.content, 'utf8').toString('base64')
        // Remove first: a previous readonly (0444) seed would make the write fail.
        lines.push(`rm -f ${full}`)
        lines.push(`echo "${b64}" | base64 -d > ${full}`)
        if (f.readonly) lines.push(`chmod 0444 ${full}`)
    }
    // The agent runs as UID 1000 and must be able to write inside these dirs.
    // At the volume root (`CLAUDE.md`) only what was written: a recursive
    // chown there walks the agent's whole home — 1.9 M files on a busy one,
    // over 80 s of every spawn — to fix files that are already its own.
    if (targetDir === '.') {
        lines.push(`chown 1000:1000 ${root}`)
        for (const f of opts.files) {
            // The file and each folder on the way to it, one by one.
            const parts = f.path.split('/')
            for (let i = 1; i <= parts.length; i++)
                lines.push(`chown 1000:1000 ${shellQuote(`/v/${parts.slice(0, i).join('/')}`)}`)
        }
    } else {
        lines.push(`chown -R 1000:1000 ${root}`)
    }
    return { script: lines.join('\n'), targetDir }
}
