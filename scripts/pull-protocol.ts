/**
 * Fetch the canonical protocol.ts from the control and write it to
 * src/protocol.ts. Runs as the `prebuild` step so every build links
 * against the latest wire format.
 *
 * Usage:
 *   bun run scripts/pull-protocol.ts                  # production
 *   bun run scripts/pull-protocol.ts development      # localhost:5050
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const env = process.argv[2] || 'production'

const URL_BY_ENV: Record<string, string> = {
    development: 'http://localhost:5050/protocol',
    production: 'https://api.kujira.run/protocol',
}

const url = URL_BY_ENV[env]
if (!url) {
    console.error(`✗ Unknown env "${env}". Use one of: ${Object.keys(URL_BY_ENV).join(', ')}`)
    process.exit(1)
}

const target = resolve(import.meta.dir, '..', 'src', 'protocol.ts')

console.log(`🌍 Pulling protocol from ${url}`)
try {
    const res = await fetch(url)
    if (!res.ok) {
        console.error(`✗ ${url} → HTTP ${res.status} ${res.statusText}`)
        process.exit(1)
    }
    const source = await res.text()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
    console.log(`✓ Wrote ${source.length} bytes to ${target}`)
} catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`✗ Failed to fetch protocol: ${message}`)
    process.exit(1)
}
