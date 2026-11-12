/**
 * References in the request body, for logins and token requests (a form with
 * `passwd`, an OAuth refresh with `client_secret`…): the only body that
 * needs a secret. Whatever goes in a body tends to be stored by the other
 * application, so the bar is narrower than for headers:
 *
 * - only `application/json` (or `+json`) and `application/x-www-form-urlencoded`;
 * - the reference is the WHOLE value of a field, never part of a text;
 * - the field's name says it holds a secret (`password`, `client_secret`,
 *   `refresh_token`, `api_key`…), never `comment`, `note` or `description`;
 * - the field is at the top level: never inside an object, a list or a
 *   `metadata[token]` form name, where the agent could pick a key that the
 *   service stores and shows back.
 *
 * Anything else that mentions a reference is refused before resolving it.
 * What is left (a top-level `password` that a service stores in clear) is
 * bounded by the destinations of the credential, like a header.
 */

import { KeychainError } from './errors'
import { type CredentialReference, mentionsReference, parseReference } from './references'

const EXACT = /^\{\{kj:([^{}]+)\}\}$/

/** Words in a field name that mark it as a secret. */
const SECRET_WORDS = new Set([
    'password',
    'passwd',
    'pass',
    'pwd',
    'passphrase',
    'passcode',
    'secret',
    'token',
    'key',
    'apikey',
    'otp',
    'totp',
    'pin',
    'credential',
    'credentials',
    'auth',
])

/** `client_secret`, `apiKey`, `x-api-key`, `newPassword2` → their words, lower case. */
export function nameWords(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(Boolean)
}

export function isSecretFieldName(name: string): boolean {
    return nameWords(name).some(
        (w) => SECRET_WORDS.has(w) || (w.endsWith('s') && SECRET_WORDS.has(w.slice(0, -1)))
    )
}

export type BodyKind = 'json' | 'form'

export function bodyKind(contentType: string | null): BodyKind | null {
    const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)) {
        return 'json'
    }
    if (type === 'application/x-www-form-urlencoded') return 'form'
    return null
}

/** Where a checked reference sits in the text: `[start, end)` is replaced. */
interface Slot {
    start: number
    end: number
    ref: CredentialReference
}

export interface BodyReferences {
    kind: BodyKind
    text: string
    refs: CredentialReference[]
    /** Exactly the positions that were checked: the only ones filled. */
    slots: Slot[]
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

function refused(detail: string): KeychainError {
    return new KeychainError(
        'KEYCHAIN_REF_IN_BODY',
        `${detail} En el cuerpo, una credencial sólo va como valor completo de un campo ` +
            'de contraseña, clave o token (password, passwd, client_secret, refresh_token, ' +
            'api_key…) de un formulario o un JSON, por ejemplo ' +
            '{"email": "…", "password": "{{kj:<credencial>.<campo>}}"}. La petición no ha salido.'
    )
}

function exactReference(value: string): CredentialReference | null {
    const match = EXACT.exec(value)
    if (!match) return null
    const parsed = parseReference(match[1] ?? '')
    return parsed ? { raw: match[0], ...parsed } : null
}

/**
 * The references a body carries, checked; null when it mentions none. Throws
 * if it mentions one anywhere it is not allowed.
 */
export function bodyReferences(
    contentType: string | null,
    body: Uint8Array | null
): BodyReferences | null {
    if (!body?.length) return null
    const raw = Buffer.from(body).toString('latin1')
    const kind = bodyKind(contentType)
    const mentioned = mentionsReference(raw)
    // JSON may escape the braces (a backslash-u escape): looked for once parsed.
    if (!mentioned) {
        if (kind !== 'json' || !raw.includes('\\u')) return null
        let text: string
        try {
            text = UTF8.decode(body)
            JSON.parse(text)
        } catch {
            return null
        }
        // Throws where an escaped reference is not allowed, like a plain one.
        if (!jsonSlots(text).length) return null
    }
    if (!kind) {
        throw refused(
            'Hay una referencia a una credencial en un cuerpo que no es un formulario ' +
                '(application/x-www-form-urlencoded) ni JSON (application/json).'
        )
    }
    let text: string
    try {
        text = UTF8.decode(body)
    } catch {
        throw refused('El cuerpo con la referencia no es texto UTF-8.')
    }
    const slots = kind === 'json' ? jsonSlots(text) : formSlots(text)
    return { kind, text, refs: slots.map((s) => s.ref), slots }
}

function nested(): KeychainError {
    return refused('Hay una referencia dentro de otro campo o de una lista.')
}

function checkField(name: string | null, value: string): CredentialReference {
    const ref = exactReference(value)
    if (!ref) {
        throw refused(
            name
                ? `La referencia del campo «${name}» va mezclada con otro texto.`
                : 'Hay una referencia mezclada con otro texto.'
        )
    }
    if (name === null || !isSecretFieldName(name)) {
        throw refused(
            name === null
                ? 'Hay una referencia fuera de un campo con nombre.'
                : `El campo «${name}» no es de contraseña, clave ni token.`
        )
    }
    return ref
}

interface Frame {
    array: boolean
    expectKey: boolean
    key: string | null
}

/**
 * Walks the JSON text itself, string literal by string literal, so what is
 * checked is what gets filled: `JSON.parse` keeps only the LAST of two equal
 * keys, and a check on the parsed object would let an earlier one (nested, or
 * under a name that is not a secret) through to the filling.
 */
function jsonSlots(text: string): Slot[] {
    try {
        JSON.parse(text)
    } catch {
        throw refused('El cuerpo dice ser JSON pero no lo es.')
    }
    const slots: Slot[] = []
    const stack: Frame[] = []
    let i = 0
    while (i < text.length) {
        const ch = text[i]
        const top = stack[stack.length - 1]
        if (ch === '"') {
            let end = i + 1
            while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1
            const decoded = JSON.parse(text.slice(i, end + 1)) as string
            const isKey = !!top && !top.array && top.expectKey
            if (isKey && top) top.key = decoded
            if (mentionsReference(decoded)) {
                if (isKey) throw refused('Hay una referencia en el nombre de un campo.')
                // Below the top level the agent picks the name
                // (`{"metadata": {"token": …}}`) and the service stores it.
                if (stack.length !== 1 || !top || top.array) throw nested()
                slots.push({ start: i, end: end + 1, ref: checkField(top.key, decoded) })
            }
            i = end + 1
            continue
        }
        if (ch === '{') stack.push({ array: false, expectKey: true, key: null })
        else if (ch === '[') stack.push({ array: true, expectKey: false, key: null })
        else if (ch === '}' || ch === ']') stack.pop()
        else if (ch === ':' && top) top.expectKey = false
        else if (ch === ',' && top && !top.array) top.expectKey = true
        i++
    }
    return slots
}

function formDecode(text: string): string | null {
    try {
        return decodeURIComponent(text.replace(/\+/g, ' '))
    } catch {
        return null
    }
}

function formSlots(text: string): Slot[] {
    const slots: Slot[] = []
    let offset = 0
    for (const pair of text.split('&')) {
        const start = offset
        offset += pair.length + 1
        if (!mentionsReference(pair)) continue
        const eq = pair.indexOf('=')
        const rawName = eq < 0 ? pair : pair.slice(0, eq)
        const name = formDecode(rawName)
        if (name === null || mentionsReference(rawName)) {
            throw refused('Hay una referencia en el nombre de un campo.')
        }
        // `metadata[token]`, `user.password`: a nested field, as in JSON.
        if (/[[\].]/.test(name)) throw nested()
        const value = eq < 0 ? null : formDecode(pair.slice(eq + 1))
        if (value === null) throw refused(`El valor del campo «${name}» no se entiende.`)
        slots.push({
            start: start + eq + 1,
            end: start + pair.length,
            ref: checkField(name, value),
        })
    }
    return slots
}

/**
 * The body with each checked reference replaced by its value, at the position
 * where it was checked and nowhere else: every other byte goes out as the
 * agent wrote it (a JSON number is not re-serialised, a form field is not
 * re-encoded).
 */
export function fillBody(found: BodyReferences, values: Map<string, string>): Uint8Array {
    let out = ''
    let at = 0
    for (const slot of [...found.slots].sort((a, b) => a.start - b.start)) {
        const value = values.get(slot.ref.raw)
        // A reference without its value would go out as text: never.
        if (value === undefined) throw refused('No se ha podido poner la credencial en el cuerpo.')
        out += found.text.slice(at, slot.start)
        out += found.kind === 'json' ? JSON.stringify(value) : encodeURIComponent(value)
        at = slot.end
    }
    out += found.text.slice(at)
    return new TextEncoder().encode(out)
}
