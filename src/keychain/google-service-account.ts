/**
 * A Google service account key (the JSON Google hands out as a file) used by
 * reference: the agent writes `Authorization: Bearer {{kj:Google.key}}` and
 * kj-keychain signs the JWT, trades it for an access token and puts THAT in
 * the header. The private key never leaves kj-keychain, and the token only
 * goes to Google APIs.
 *
 * Scopes and the account to act as (domain-wide delegation) come in
 * `X-Kj-Google-Scopes` and `X-Kj-Google-Subject`, which are never forwarded.
 */

import { createHash, createSign } from 'node:crypto'

import { KeychainError } from './errors'
import type { Fetcher } from './handler'

export const GOOGLE_SCOPES_HEADER = 'x-kj-google-scopes'
export const GOOGLE_SUBJECT_HEADER = 'x-kj-google-subject'

/** Always this one: never the `token_uri` of the JSON, which whoever wrote it chose. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const DEFAULT_GOOGLE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/** Where a token minted here may go. Each one still has to be a destination of the credential. */
const GOOGLE_API_SUFFIXES = ['googleapis.com']

const SCOPE = /^https:\/\/(www\.googleapis\.com\/auth\/[a-z0-9._/-]+|mail\.google\.com\/)$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Renewed this long before Google says it expires. */
const EARLY_MS = 5 * 60_000
/** Tokens kept at once; past it the expired go first, then the oldest. */
export const MAX_CACHED_TOKENS = 256
/** New tokens per service account per hour (a loop over subjects would burn Google's quota). */
export const MAX_MINTS_PER_HOUR = 60

export interface ServiceAccountKey {
    client_email: string
    private_key: string
    private_key_id?: string
}

/** The key if `value` is a service account JSON; null if it is anything else. */
export function parseServiceAccount(value: string): ServiceAccountKey | null {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(trimmed)
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    if (p.type !== 'service_account') return null
    if (typeof p.client_email !== 'string' || typeof p.private_key !== 'string') return null
    if (!p.private_key.includes('PRIVATE KEY')) return null
    return {
        client_email: p.client_email,
        private_key: p.private_key,
        private_key_id: typeof p.private_key_id === 'string' ? p.private_key_id : undefined,
    }
}

export function isGoogleApiHost(host: string): boolean {
    return GOOGLE_API_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
}

export interface GoogleGrant {
    scopes: string[]
    subject: string | null
}

/** Field labels of the credential that say what its key may be used for. */
export const GOOGLE_GRANT_LABELS = {
    scopes: ['scopes', 'google_scopes', 'scope'],
    subjects: ['subject', 'subjects', 'google_subject', 'impersonate'],
} as const

/** What the credential allows; null = the field is not there. */
export interface GoogleAllowed {
    scopes: string[] | null
    subjects: string[] | null
}

function list(value: string | null | undefined): string[] | null {
    if (value === null || value === undefined) return null
    const items = value.split(/[\s,;]+/).filter(Boolean)
    return items.length ? items : null
}

export function googleAllowed(scopes: string | null, subjects: string | null): GoogleAllowed {
    return {
        scopes: list(scopes),
        subjects: list(subjects)?.map((s) => s.toLowerCase()) ?? null,
    }
}

/**
 * The scopes and the account the token is minted for. The headers come from
 * the agent, which reads mail and pages written by anyone (SOKI, #219), so
 * they only ever NARROW what the credential lists: scopes in its `scopes`
 * field, accounts in its `subject` field. Without the header, everything the
 * credential lists (the first account). A credential that lists no scopes
 * only gets cloud-platform, and one that lists no account acts as itself.
 */
export function googleGrant(headers: Headers, allowed: GoogleAllowed): GoogleGrant {
    const raw = headers.get(GOOGLE_SCOPES_HEADER)?.trim()
    const permitted = allowed.scopes ?? [DEFAULT_GOOGLE_SCOPE]
    const scopes = raw ? raw.split(/[\s,]+/).filter(Boolean) : permitted
    for (const scope of scopes) {
        if (!SCOPE.test(scope) || scope.length > 200) {
            throw new KeychainError(
                'KEYCHAIN_BAD_REQUEST',
                `«${scope.slice(0, 200)}» no es un scope de Google. Pon en X-Kj-Google-Scopes las URL ` +
                    'completas separadas por espacios, por ejemplo ' +
                    'https://www.googleapis.com/auth/spreadsheets.'
            )
        }
        if (!permitted.includes(scope)) {
            throw new KeychainError(
                'KEYCHAIN_GOOGLE_NOT_ALLOWED',
                `La credencial no permite el scope ${scope}; sólo ${permitted.join(', ')}. ` +
                    'La petición no ha salido. Si hace falta, el operador lo añade al campo scopes de la credencial.'
            )
        }
    }
    const asked = headers.get(GOOGLE_SUBJECT_HEADER)?.trim().toLowerCase() || null
    if (asked && (asked.length > 320 || !EMAIL.test(asked))) {
        throw new KeychainError(
            'KEYCHAIN_BAD_REQUEST',
            'X-Kj-Google-Subject tiene que ser el correo de la cuenta en cuyo nombre se actúa.'
        )
    }
    if (asked && !allowed.subjects?.includes(asked)) {
        throw new KeychainError(
            'KEYCHAIN_GOOGLE_NOT_ALLOWED',
            allowed.subjects
                ? `La credencial sólo puede actuar como ${allowed.subjects.join(', ')}, no como ${asked}. La petición no ha salido.`
                : 'La credencial no permite actuar en nombre de nadie. La petición no ha salido. Si hace falta, el operador ' +
                      'pone el correo en el campo subject de la credencial.'
        )
    }
    const subject = asked ?? allowed.subjects?.[0] ?? null
    return { scopes: [...new Set(scopes)].sort(), subject }
}

function base64url(input: Buffer | string): string {
    return Buffer.from(input).toString('base64url')
}

export function signAssertion(key: ServiceAccountKey, grant: GoogleGrant, nowMs: number): string {
    const iat = Math.floor(nowMs / 1000)
    const header = {
        alg: 'RS256',
        typ: 'JWT',
        ...(key.private_key_id ? { kid: key.private_key_id } : {}),
    }
    const claims = {
        iss: key.client_email,
        scope: grant.scopes.join(' '),
        aud: GOOGLE_TOKEN_URL,
        iat,
        exp: iat + 3600,
        ...(grant.subject ? { sub: grant.subject } : {}),
    }
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
    const signer = createSign('RSA-SHA256')
    signer.update(unsigned)
    let signature: Buffer
    try {
        signature = signer.sign(key.private_key)
    } catch {
        throw new KeychainError(
            'KEYCHAIN_BAD_REFERENCE',
            'La clave privada de la cuenta de servicio no se puede leer. Revisa que la ' +
                'credencial tenga el JSON tal como lo descargó Google.'
        )
    }
    return `${unsigned}.${base64url(signature)}`
}

/** Access tokens per (key, scopes, subject), in memory, until shortly before they expire. */
export class GoogleTokenMinter {
    private readonly tokens = new Map<string, { token: string; expires: number }>()
    private readonly inflight = new Map<string, Promise<string>>()
    private readonly mints = new Map<string, number[]>()

    constructor(
        private readonly fetch: Fetcher,
        private readonly now: () => number = Date.now
    ) {}

    async token(key: ServiceAccountKey, grant: GoogleGrant): Promise<string> {
        const id = createHash('sha256')
            .update(
                JSON.stringify([key.client_email, key.private_key, grant.scopes, grant.subject])
            )
            .digest('hex')
        const hit = this.tokens.get(id)
        if (hit && hit.expires > this.now()) return hit.token
        const running = this.inflight.get(id)
        if (running) return running
        this.takeMint(key.client_email)
        const pending = this.mint(key, grant)
            .then((minted) => {
                this.store(id, minted)
                return minted.token
            })
            .finally(() => this.inflight.delete(id))
        this.inflight.set(id, pending)
        return pending
    }

    private takeMint(account: string): void {
        const since = this.now() - 60 * 60_000
        const recent = (this.mints.get(account) ?? []).filter((t) => t > since)
        if (recent.length >= MAX_MINTS_PER_HOUR) {
            this.mints.set(account, recent)
            throw new KeychainError(
                'KEYCHAIN_RATE_LIMITED',
                `La cuenta de servicio ya ha pedido ${MAX_MINTS_PER_HOUR} tokens a Google en la última ` +
                    'hora. Reutiliza los mismos scopes y la misma cuenta, o espera.'
            )
        }
        recent.push(this.now())
        this.mints.set(account, recent)
    }

    private store(id: string, minted: { token: string; expires: number }): void {
        if (this.tokens.size >= MAX_CACHED_TOKENS) {
            const now = this.now()
            for (const [k, v] of this.tokens) if (v.expires <= now) this.tokens.delete(k)
            while (this.tokens.size >= MAX_CACHED_TOKENS) {
                const oldest = this.tokens.keys().next().value
                if (oldest === undefined) break
                this.tokens.delete(oldest)
            }
        }
        this.tokens.delete(id)
        this.tokens.set(id, minted)
    }

    /** How many tokens are kept (tests). */
    get size(): number {
        return this.tokens.size
    }

    private async mint(
        key: ServiceAccountKey,
        grant: GoogleGrant
    ): Promise<{ token: string; expires: number }> {
        const assertion = signAssertion(key, grant, this.now())
        let response: Response
        try {
            response = await this.fetch(GOOGLE_TOKEN_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                    assertion,
                }).toString(),
                redirect: 'manual',
            })
        } catch {
            throw new KeychainError(
                'KEYCHAIN_UPSTREAM_FAILED',
                'No se ha podido pedir el token a Google (oauth2.googleapis.com).'
            )
        }
        const text = await response.text().catch(() => '')
        let body: Record<string, unknown> = {}
        try {
            body = JSON.parse(text) as Record<string, unknown>
        } catch {}
        if (!response.ok || typeof body.access_token !== 'string') {
            // Google's error is about the request (bad scope, delegation not
            // granted, key revoked); it never echoes the key or the assertion.
            const reason = [body.error, body.error_description]
                .filter((s): s is string => typeof s === 'string')
                .join(': ')
                .slice(0, 300)
            throw new KeychainError(
                'KEYCHAIN_GOOGLE_TOKEN_FAILED',
                `Google no ha dado el token de la cuenta de servicio${reason ? ` (${reason})` : ''}. ` +
                    (grant.subject
                        ? 'Si actúas en nombre de una cuenta, la delegación de dominio tiene que ' +
                          'estar autorizada en Google Workspace para estos scopes.'
                        : 'Revisa los scopes y que la cuenta de servicio siga activa.')
            )
        }
        const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600
        return {
            token: body.access_token,
            expires: this.now() + Math.max(0, seconds * 1000 - EARLY_MS),
        }
    }
}
