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

export interface BodyReferences {
    kind: BodyKind
    text: string
    refs: CredentialReference[]
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
        let parsed: unknown
        try {
            parsed = JSON.parse(UTF8.decode(body))
        } catch {
            return null
        }
        // Re-serialised, the braces come out as braces.
        if (!mentionsReference(JSON.stringify(parsed))) return null
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
    const refs = kind === 'json' ? jsonReferences(text) : formReferences(text)
    return { kind, text, refs }
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

function jsonReferences(text: string): CredentialReference[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw refused('El cuerpo dice ser JSON pero no lo es.')
    }
    const refs: CredentialReference[] = []
    // Anything below the top level is refused: there the agent picks the
    // name (`{"metadata": {"token": …}}`) and the service stores it.
    const deep = (value: unknown) => {
        if (mentionsReference(JSON.stringify(value) ?? '')) throw nested()
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        deep(parsed)
        return refs
    }
    for (const [key, value] of Object.entries(parsed)) {
        if (mentionsReference(key)) throw refused('Hay una referencia en el nombre de un campo.')
        if (typeof value === 'string') {
            if (mentionsReference(value)) refs.push(checkField(key, value))
        } else {
            deep(value)
        }
    }
    return refs
}

function formDecode(text: string): string | null {
    try {
        return decodeURIComponent(text.replace(/\+/g, ' '))
    } catch {
        return null
    }
}

function formReferences(text: string): CredentialReference[] {
    const refs: CredentialReference[] = []
    for (const pair of text.split('&')) {
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
        refs.push(checkField(name, value))
    }
    return refs
}

/**
 * The body with every reference replaced by its value. Only the references'
 * own tokens change: every other byte goes out as the agent wrote it (a JSON
 * number is not re-serialised, a form field is not re-encoded).
 */
export function fillBody(found: BodyReferences, values: Map<string, string>): Uint8Array {
    // A reference without its value would go out as text: never.
    if (found.refs.some((ref) => !values.has(ref.raw))) {
        throw refused('No se ha podido poner la credencial en el cuerpo.')
    }
    const out = found.kind === 'json' ? fillJson(found.text, values) : fillForm(found.text, values)
    return new TextEncoder().encode(out)
}

function fillJson(text: string, values: Map<string, string>): string {
    let out = ''
    let i = 0
    while (i < text.length) {
        const ch = text[i]
        if (ch !== '"') {
            out += ch
            i++
            continue
        }
        let end = i + 1
        while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
        const literal = text.slice(i, end + 1)
        const decoded = JSON.parse(literal) as string
        const value = EXACT.test(decoded) ? values.get(decoded) : undefined
        out += value === undefined ? literal : JSON.stringify(value)
        i = end + 1
    }
    return out
}

function fillForm(text: string, values: Map<string, string>): string {
    return text
        .split('&')
        .map((pair) => {
            const eq = pair.indexOf('=')
            if (eq < 0) return pair
            const decoded = formDecode(pair.slice(eq + 1))
            const value = decoded !== null && EXACT.test(decoded) ? values.get(decoded) : undefined
            return value === undefined ? pair : `${pair.slice(0, eq)}=${encodeURIComponent(value)}`
        })
        .join('&')
}
