/**
 * Credential references: `{{kj:<credential>.<field>}}`. The credential name
 * may contain spaces and dots, so the split is on the LAST dot.
 */

export interface CredentialReference {
    /** The whole `{{kj:…}}` text, as written. */
    raw: string
    credential: string
    field: string
}

/** The only headers where a reference may be substituted (lower case). */
export const REFERENCE_HEADERS: ReadonlySet<string> = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'x-auth-token',
    'x-access-token',
])

const STRICT = /\{\{kj:([^{}]+)\}\}/g
/** Loose detector: anything that looks like the start of a reference. */
const LOOSE = /\{\{\s*kj\s*:/i

export function parseReference(inner: string): { credential: string; field: string } | null {
    const dot = inner.lastIndexOf('.')
    if (dot < 0) return null
    const credential = inner.slice(0, dot).trim()
    const field = inner.slice(dot + 1).trim()
    if (!credential || !field) return null
    return { credential, field }
}

/** True if `text` (raw or percent-decoded) contains something that looks like a reference. */
export function mentionsReference(text: string): boolean {
    if (LOOSE.test(text)) return true
    if (!text.includes('%')) return false
    return LOOSE.test(safeDecode(text))
}

/**
 * The references in an allowed header value. Returns null if the value
 * mentions a reference that does not parse (`{{kj:foo}}`, `{{ kj:a.b }}`…).
 */
export function extractReferences(value: string): CredentialReference[] | null {
    const refs: CredentialReference[] = []
    for (const match of value.matchAll(STRICT)) {
        const parsed = parseReference(match[1] ?? '')
        if (!parsed) return null
        refs.push({ raw: match[0], ...parsed })
    }
    const leftover = value.replace(STRICT, '')
    if (LOOSE.test(leftover)) return null
    return refs
}

export function substituteReferences(value: string, values: Map<string, string>): string {
    return value.replace(STRICT, (raw) => values.get(raw) ?? raw)
}

function safeDecode(text: string): string {
    try {
        return decodeURIComponent(text.replace(/\+/g, ' '))
    } catch {
        return text
    }
}
