/**
 * Fetch the canonical protocol.ts from the control and write it to
 * src/protocol.ts. Runs as the `prebuild` step so every build links
 * against the latest wire format.
 *
 * Usage:
 *   bun run scripts/pull-protocol.ts                  # production
 *   bun run scripts/pull-protocol.ts development      # localhost:5050
 *
 * Drift detection: if the local protocol.ts is ahead of production
 * (typically during deploy windows when the backend hasn't redeployed
 * yet), we keep the local copy and warn instead of overwriting. This
 * prevents CI builds from silently downgrading our types. We detect
 * "ahead" by comparing the set of exported identifiers — if local has
 * symbols remote lacks, local wins.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const env = process.argv[2] || 'production'

const URL_BY_ENV: Record<string, string> = {
    development: 'http://localhost:5050/protocol',
    production: 'https://api.kujira.so/protocol',
}

const url = URL_BY_ENV[env]
if (!url) {
    console.error(`✗ Unknown env "${env}". Use one of: ${Object.keys(URL_BY_ENV).join(', ')}`)
    process.exit(1)
}

const target = resolve(import.meta.dir, '..', 'src', 'protocol.ts')

function extractExports(source: string): Set<string> {
    const names = new Set<string>()
    const regex =
        /export\s+(?:type\s+|interface\s+|class\s+|const\s+|function\s+|enum\s+)?([A-Z_][A-Za-z0-9_]*)/g
    for (const match of source.matchAll(regex)) {
        if (match[1]) names.add(match[1])
    }
    return names
}

console.log(`🌍 Pulling protocol from ${url}`)
try {
    const res = await fetch(url)
    if (!res.ok) {
        console.error(`✗ ${url} → HTTP ${res.status} ${res.statusText}`)
        process.exit(1)
    }
    const remoteSource = await res.text()

    if (existsSync(target)) {
        const localSource = readFileSync(target, 'utf8')
        const localExports = extractExports(localSource)
        const remoteExports = extractExports(remoteSource)
        const onlyInLocal = [...localExports].filter((n) => !remoteExports.has(n))
        // Also detect new fields: if local has more characters AND
        // includes all remote symbols, treat it as ahead.
        const localIsSuperset =
            onlyInLocal.length === 0 &&
            localSource.length > remoteSource.length &&
            [...remoteExports].every((n) => localExports.has(n))

        if (onlyInLocal.length > 0 || localIsSuperset) {
            console.warn(`⚠ Local protocol.ts looks ahead of ${env}.`)
            if (onlyInLocal.length > 0) {
                console.warn(`  Exports only in local: ${onlyInLocal.join(', ')}`)
            }
            console.warn(`  Keeping local copy. Re-run after the control deploys.`)
            process.exit(0)
        }
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, remoteSource)
    console.log(`✓ Wrote ${remoteSource.length} bytes to ${target}`)
} catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`✗ Failed to fetch protocol: ${message}`)
    process.exit(1)
}
