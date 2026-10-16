/**
 * Fetch the canonical protocol.ts from the control and write it to
 * src/protocol.ts. Runs as the `prebuild` step so every build links
 * against the latest wire format.
 *
 * Usage:
 *   bun run scripts/pull-protocol.ts                  # production
 *   bun run scripts/pull-protocol.ts development      # localhost:5050
 *   bun run scripts/pull-protocol.ts --update-pin     # rewrite protocol.sha256
 *
 * Drift detection: if the local protocol.ts is ahead of production
 * (typically during deploy windows when the backend hasn't redeployed
 * yet), we keep the local copy and warn instead of overwriting. This
 * prevents CI builds from silently downgrading our types. We detect
 * "ahead" by comparing the set of exported identifiers — if local has
 * symbols remote lacks, local wins.
 *
 * Integrity (calltek/kj-supervisor#24): the body is compiled into the
 * published image, so it is validated before it touches src/protocol.ts —
 * HTTP 200, plausible content-type, not empty/HTML, parses as TypeScript
 * (never executed) and still exports what the supervisor uses
 * (see scripts/protocol-validator.ts).
 *
 * Optional hash pin (OFF by default). The backend redeploys protocol.ts every
 * time the wire format changes, so a mandatory pin would turn CI red after
 * each backend deploy until someone updated the hash. Instead:
 *   bun run scripts/pull-protocol.ts --update-pin   # writes protocol.sha256
 *   KJ_PROTOCOL_PIN=1 bun run pull-protocol         # fails if body != pin
 * Update the pin in a reviewable PR: commit protocol.sha256 and review the
 * protocol diff against the backend.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { checkPin, extractExports, sha256, validateProtocolBody } from './protocol-validator'

const args = process.argv.slice(2)
const updatePin = args.includes('--update-pin')
const env = args.find((a) => !a.startsWith('--')) || 'production'

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
const pinFile = resolve(import.meta.dir, '..', 'protocol.sha256')

console.log(`🌍 Pulling protocol from ${url}`)
try {
    const res = await fetch(url)
    if (!res.ok) {
        console.error(`✗ ${url} → HTTP ${res.status} ${res.statusText}`)
        process.exit(1)
    }
    const remoteSource = await res.text()

    const problems = validateProtocolBody(remoteSource, res.headers.get('content-type'))
    if (problems.length > 0) {
        console.error(`✗ Refusing the response from ${url}:`)
        for (const p of problems) console.error(`  - ${p}`)
        process.exit(1)
    }

    if (updatePin) {
        writeFileSync(pinFile, `${sha256(remoteSource)}\n`)
        console.log(`✓ Pin updated (${pinFile}). Commit it in a PR and review the protocol diff.`)
        process.exit(0)
    }

    if (process.env.KJ_PROTOCOL_PIN === '1') {
        if (!existsSync(pinFile)) {
            console.error('✗ KJ_PROTOCOL_PIN=1 but protocol.sha256 does not exist.')
            process.exit(1)
        }
        const mismatch = checkPin(remoteSource, readFileSync(pinFile, 'utf8'))
        if (mismatch) {
            console.error(`✗ ${mismatch}`)
            console.error(
                '  If the backend changed the protocol on purpose, run\n' +
                    '  `bun run scripts/pull-protocol.ts --update-pin` and open a PR with protocol.sha256.'
            )
            process.exit(1)
        }
    }

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
