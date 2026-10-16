/**
 * Validation of the protocol.ts body downloaded from the control, before it
 * is written to src/protocol.ts (which gets compiled into the published
 * image). Nothing here executes the body: it is only parsed.
 */

import { createHash } from 'node:crypto'

/** Identifiers the supervisor cannot live without; a body lacking any is not our protocol. */
export const REQUIRED_EXPORTS = [
    'PROTOCOL_VERSION',
    'AgentSpawnPayload',
    'AgentInputPayload',
    'AgentStatusReport',
] as const

const MAX_BYTES = 2_000_000

export function extractExports(rawSource: string): Set<string> {
    // Drop comments so a name mentioned only in a comment does not count as an export.
    const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const names = new Set<string>()
    const regex =
        /export\s+(?:type\s+|interface\s+|class\s+|const\s+|function\s+|enum\s+)?([A-Z_][A-Za-z0-9_]*)/g
    for (const match of source.matchAll(regex)) {
        if (match[1]) names.add(match[1])
    }
    return names
}

export function sha256(source: string): string {
    return createHash('sha256').update(source).digest('hex')
}

/** Returns a list of problems; empty means the body is acceptable. */
export function validateProtocolBody(body: string, contentType: string | null): string[] {
    const problems: string[] = []

    if (contentType) {
        const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
        // The control serves text/typescript; accept text/* and the usual TS aliases,
        // reject html/json/images/etc. (error pages, captive portals).
        const plausible =
            (type.startsWith('text/') && type !== 'text/html') ||
            type === 'application/typescript' ||
            type === 'application/x-typescript' ||
            type === 'application/octet-stream'
        if (!plausible) problems.push(`unexpected content-type "${type}"`)
    }

    if (body.trim().length === 0) {
        problems.push('empty body')
        return problems
    }
    if (body.length > MAX_BYTES) problems.push(`body too large (${body.length} bytes)`)
    if (/^\s*(<!doctype\s+html|<html[\s>]|<\?xml|<head[\s>]|<body[\s>])/i.test(body)) {
        problems.push('body looks like HTML, not TypeScript')
        return problems
    }

    try {
        // Parse only; transform never runs the code.
        new Bun.Transpiler({ loader: 'ts' }).transformSync(body)
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        problems.push(`body does not parse as TypeScript: ${detail.split('\n')[0]}`)
        return problems
    }

    const exports = extractExports(body)
    const missing = REQUIRED_EXPORTS.filter((n) => !exports.has(n))
    if (missing.length > 0) problems.push(`missing expected exports: ${missing.join(', ')}`)

    return problems
}

/**
 * Optional pin: the file holds the expected sha256 of the body. Returns a
 * problem string when it does not match, undefined when it does.
 */
export function checkPin(body: string, pinFileContent: string): string | undefined {
    const expected = pinFileContent.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    const actual = sha256(body)
    return expected === actual
        ? undefined
        : `sha256 mismatch: pin has ${expected || '(empty)'}, downloaded body is ${actual}`
}
