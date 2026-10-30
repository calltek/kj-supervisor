/**
 * Hides the credential values used in a request from the response the agent
 * gets back: as written, in standard and url-safe base64 (also inside a longer
 * base64 string, e.g. `Basic user:pass`), percent-encoded and JSON-escaped.
 * Short values are hidden too: there is no length exception.
 */

export const REDACTED = '[credencial oculta]'

/** Aligned base64 fragments shorter than this are not used (too many false hits). */
const MIN_ALIGNED_FRAGMENT = 8

function base64Variants(value: string): string[] {
    const bytes = Buffer.from(value, 'utf8')
    const out: string[] = []
    // Offset 0, 1 and 2 inside a longer base64 stream: keep only the
    // characters that depend on the value's bytes alone.
    for (const offset of [0, 1, 2]) {
        const padded = Buffer.concat([Buffer.alloc(offset), bytes])
        const encoded = padded.toString('base64')
        const start = offset === 0 ? 0 : offset + 1
        const total = padded.length
        const rest = total % 3
        const end = Math.floor(total / 3) * 4 + (rest === 0 ? 0 : rest)
        const fragment = encoded.slice(start, end)
        if (fragment.length >= MIN_ALIGNED_FRAGMENT) out.push(fragment)
    }
    // The whole value encoded on its own, with and without padding: always,
    // however short.
    const whole = bytes.toString('base64')
    out.push(whole, whole.replace(/=+$/, ''))
    const urlSafe = out.map((v) => v.replace(/\+/g, '-').replace(/\//g, '_'))
    return [...out, ...urlSafe]
}

/** Every form of `value` that gets hidden, longest first. */
export function secretVariants(value: string): string[] {
    if (!value) return []
    const variants = new Set<string>([value])
    for (const v of base64Variants(value)) variants.add(v)
    variants.add(encodeURIComponent(value))
    variants.add(encodeURIComponent(value).replace(/%20/g, '+'))
    variants.add(JSON.stringify(value).slice(1, -1))
    variants.delete('')
    return [...variants].sort((a, b) => b.length - a.length)
}

export function collectVariants(values: Iterable<string>): string[] {
    const all = new Set<string>()
    for (const value of values) for (const v of secretVariants(value)) all.add(v)
    return [...all].sort((a, b) => b.length - a.length)
}

export function redactText(text: string, variants: string[]): string {
    let out = text
    for (const v of variants) if (out.includes(v)) out = out.split(v).join(REDACTED)
    return out
}

/**
 * Byte-level redaction, so a binary or non-UTF-8 body keeps every other byte
 * as it was. Works on a latin1 view, where one char is one byte.
 */
export function redactBytes(body: Uint8Array, variants: string[]): Uint8Array {
    if (!variants.length || !body.length) return body
    const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('latin1')
    const asLatin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1')
    const redacted = redactText(view, variants.map(asLatin1))
    if (redacted === view) return body
    // REDACTED is ASCII, so its latin1 bytes are its UTF-8 bytes.
    return new Uint8Array(Buffer.from(redacted, 'latin1'))
}
