/**
 * The agent-facing endpoint, `/r` (credenciales-por-referencia.md §7).
 *
 * The launcher forwards the conversation's request with its original method,
 * headers and body, plus `X-Kj-Token` (the agent), `X-Kj-Session` (the
 * conversation) and `X-Kj-Target` (the absolute https URL). kj-keychain puts
 * the credential values in the allowed auth headers, sends the request to the
 * destination, and returns the answer with every value used hidden.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import type { KeychainSite } from './control-protocol'
import { KeychainError, errorResponse } from './errors'
import { isBlockedAddress } from './addresses'
import type { KeychainLog } from './log'
import {
    type CredentialReference,
    REFERENCE_HEADERS,
    authHeaderValue,
    extractReferences,
    mentionsReference,
} from './references'
import { collectVariants, redactBytes, redactText } from './redact'
import type { AgentTokenRegistry } from './registry'
import type { Resolve } from './resolver'
import { describeSites, hostMatchesAnySite, normalizeHost } from './sites'

export const AGENT_PATH = '/r'
export const MAX_BODY_BYTES = 32 * 1024 * 1024

const TOKEN_HEADER = 'x-kj-token'
const SESSION_HEADER = 'x-kj-session'
const TARGET_HEADER = 'x-kj-target'

/** Never forwarded to the destination (besides every `X-Kj-*`). */
const HOP_BY_HOP = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-length',
    // fetch negotiates (and undoes) the encoding itself.
    'accept-encoding',
])

/** Never copied back from the destination. */
const RESPONSE_DROP = new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-length',
    'content-encoding',
])

export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>
export type Fetcher = (url: string, init: BunFetchRequestInit) => Promise<Response>

export interface KeychainHandlerDeps {
    registry: AgentTokenRegistry
    resolve: Resolve
    log: KeychainLog
    fetch?: Fetcher
    lookup?: LookupAll
}

const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true, verbatim: true })

export function createKeychainHandler(deps: KeychainHandlerDeps) {
    const doFetch: Fetcher = deps.fetch ?? ((url, init) => fetch(url, init))
    const lookup = deps.lookup ?? defaultLookup

    return async function handle(request: Request): Promise<Response> {
        const started = Date.now()
        let agent_id: number | null = null
        let host: string | null = null
        try {
            const response = await proxy(request, {
                onAgent: (id) => {
                    agent_id = id
                },
                onHost: (h) => {
                    host = h
                },
            })
            deps.log('info', 'request', {
                agent_id,
                host,
                status: response.status,
                ms: Date.now() - started,
            })
            return response
        } catch (error) {
            if (error instanceof KeychainError) {
                deps.log('warn', 'request refused', {
                    agent_id,
                    host,
                    code: error.code,
                    status: error.status,
                })
                return errorResponse(error)
            }
            deps.log('error', 'request failed', { agent_id, host })
            return errorResponse(
                new KeychainError(
                    'KEYCHAIN_UPSTREAM_FAILED',
                    'No se ha podido completar la petición con la credencial.'
                )
            )
        }
    }

    async function proxy(
        request: Request,
        report: { onAgent: (id: number) => void; onHost: (host: string) => void }
    ): Promise<Response> {
        const path = new URL(request.url).pathname
        if (path !== AGENT_PATH) {
            throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'Ruta desconocida.', 404)
        }

        // 1. Who is calling.
        const agent_id = deps.registry.agentFor(request.headers.get(TOKEN_HEADER))
        if (agent_id === null) {
            throw new KeychainError(
                'KEYCHAIN_UNAUTHORIZED',
                'Petición sin un token de agente válido.'
            )
        }
        report.onAgent(agent_id)
        const session = request.headers.get(SESSION_HEADER)?.trim()
        if (!session) {
            throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'Falta la sesión de la conversación.')
        }

        // 2. Where to.
        const rawTarget = request.headers.get(TARGET_HEADER) ?? ''
        let target: URL
        try {
            target = new URL(rawTarget)
        } catch {
            throw new KeychainError(
                'KEYCHAIN_BAD_REQUEST',
                'La dirección de destino no es una URL completa (https://…).'
            )
        }
        report.onHost(target.hostname)
        if (target.protocol !== 'https:') {
            throw new KeychainError(
                'KEYCHAIN_NOT_HTTPS',
                'Las credenciales sólo se usan por https. Cambia la dirección a https://.'
            )
        }
        if (target.username || target.password) {
            throw new KeychainError(
                'KEYCHAIN_BAD_REQUEST',
                'La dirección de destino no puede llevar usuario ni contraseña.'
            )
        }

        // 3. The body, capped, so it can be searched for references.
        const body = await readRequestBody(request)

        // 4. References: only in the allowed auth headers.
        const outside = (where: string) =>
            new KeychainError(
                'KEYCHAIN_REF_OUTSIDE_HEADER',
                `Hay una referencia a una credencial en ${where}. Las credenciales sólo se ` +
                    'pueden usar en las cabeceras Authorization, Proxy-Authorization, ' +
                    'X-API-Key, Api-Key, X-Auth-Token o X-Access-Token; nunca en la URL ni ' +
                    'en el cuerpo. La petición no ha salido.'
            )
        if (mentionsReference(rawTarget)) throw outside('la URL')
        if (body && mentionsReference(Buffer.from(body).toString('latin1'))) {
            throw outside('el cuerpo de la petición')
        }

        const forward = new Headers()
        const refs = new Map<string, CredentialReference>()
        const withRefs: [string, string][] = []
        const connectionTokens = new Set(
            (request.headers.get('connection') ?? '')
                .split(',')
                .map((t) => t.trim().toLowerCase())
                .filter(Boolean)
        )
        for (const [name, value] of request.headers) {
            const lower = name.toLowerCase()
            if (lower.startsWith('x-kj-')) continue
            const allowed = REFERENCE_HEADERS.has(lower)
            if (mentionsReference(value)) {
                if (!allowed) throw outside(`la cabecera ${name}`)
                const found = extractReferences(value)
                if (!found) {
                    throw new KeychainError(
                        'KEYCHAIN_BAD_REFERENCE',
                        `La referencia de la cabecera ${name} no se entiende. El formato es ` +
                            '{{kj:<credencial>.<campo>}}, por ejemplo {{kj:Stripe.api_key}}.'
                    )
                }
                for (const ref of found) refs.set(ref.raw, ref)
                withRefs.push([name, value])
                continue
            }
            if (HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue
            forward.append(name, value)
        }
        if (refs.size === 0) {
            throw new KeychainError(
                'KEYCHAIN_NO_REFERENCE',
                'La petición no usa ninguna credencial. Por aquí sólo pasan peticiones con ' +
                    'una referencia {{kj:<credencial>.<campo>}} en una cabecera de autenticación.'
            )
        }

        // 5. The destination must be public.
        const hostname = normalizeHost(target.hostname)
        const pinned = await checkDestination(hostname)

        // 6. Resolve every reference used.
        const resolved = new Map<string, { value: string; sites: KeychainSite[] }>()
        const byKey = new Map<string, Promise<Awaited<ReturnType<Resolve>>>>()
        for (const ref of refs.values()) {
            const key = JSON.stringify([ref.credential, ref.field])
            if (!byKey.has(key)) {
                byKey.set(
                    key,
                    deps.resolve({
                        agent_id,
                        conversation_session_id: session,
                        credential: ref.credential,
                        field: ref.field,
                    })
                )
            }
        }
        for (const ref of refs.values()) {
            const ack = await byKey.get(JSON.stringify([ref.credential, ref.field]))
            if (!ack) continue
            if (!ack.ok) throw new KeychainError(ack.code, ack.message)
            resolved.set(ref.raw, { value: ack.value, sites: ack.sites })
        }

        // 7. The host must be a destination of EVERY credential used.
        for (const ref of refs.values()) {
            const entry = resolved.get(ref.raw)
            if (!entry) continue
            const label = `«${ref.credential}»`
            if (!entry.sites.length) {
                throw new KeychainError(
                    'KEYCHAIN_NO_DESTINATION',
                    `La credencial ${label} no tiene ningún destino configurado, así que no se ` +
                        'puede usar desde aquí. Pide al operador que le añada el sitio donde se usa.'
                )
            }
            if (!hostMatchesAnySite(hostname, entry.sites)) {
                throw new KeychainError(
                    'KEYCHAIN_WRONG_SITE',
                    `La credencial ${label} sólo se puede usar en ${describeSites(entry.sites)}, ` +
                        `no en ${hostname}. La petición no ha salido. Si ese sitio también es ` +
                        'suyo, pide al operador que lo añada a los destinos de la credencial.'
                )
            }
        }

        // 8. Substitute and call, without following redirects.
        const values = new Map<string, string>()
        for (const [raw, entry] of resolved) values.set(raw, entry.value)
        const basicPairs: string[] = []
        try {
            for (const [name, value] of withRefs) {
                const header = authHeaderValue(name, value, values)
                if (header.plain) basicPairs.push(header.plain)
                forward.append(name, header.value)
            }
        } catch {
            throw new KeychainError(
                'KEYCHAIN_BAD_REFERENCE',
                'El valor de la credencial lleva caracteres que no caben en una cabecera HTTP ' +
                    '(acentos, ñ, saltos de línea…). Tal cual sólo sirve en Basic, que lo ' +
                    'codifica. La petición no ha salido. Díselo al operador.'
            )
        }
        const variants = collectVariants([...values.values(), ...basicPairs])

        let upstream: Response
        try {
            upstream = await doFetch(pinned.url(target), {
                method: request.method,
                headers: pinned.headers(forward, target),
                body: body ?? undefined,
                redirect: 'manual',
                decompress: true,
                ...(pinned.serverName ? { tls: { serverName: pinned.serverName } } : {}),
            })
        } catch (error) {
            const detail = error instanceof Error ? redactText(error.message, variants) : ''
            throw new KeychainError(
                'KEYCHAIN_UPSTREAM_FAILED',
                `No se ha podido conectar con ${hostname}${detail ? ` (${detail})` : ''}.`
            )
        }

        // 9. The answer, capped and with every value hidden.
        return buildResponse(request.method, upstream, variants)
    }

    async function checkDestination(hostname: string): Promise<PinnedDestination> {
        const blocked = () =>
            new KeychainError(
                'KEYCHAIN_PRIVATE_ADDRESS',
                `${hostname} apunta a una dirección privada o local. Las credenciales sólo se ` +
                    'usan contra servicios públicos en internet.'
            )
        if (isIP(hostname)) {
            if (isBlockedAddress(hostname)) throw blocked()
            return literalDestination()
        }
        let addresses: { address: string; family: number }[]
        try {
            addresses = await lookup(hostname)
        } catch {
            addresses = []
        }
        if (!addresses.length) {
            throw new KeychainError(
                'KEYCHAIN_DNS_FAILED',
                `No se encuentra ${hostname}. Revisa que la dirección esté bien escrita.`
            )
        }
        if (addresses.some((a) => isBlockedAddress(a.address))) throw blocked()
        // IPv4 first: the default bridge has no IPv6 route, so an AAAA first would
        // fail even with a good A record behind it.
        const first = addresses.find((a) => a.family === 4) ?? addresses[0]
        if (!first) throw blocked()
        return pinnedDestination(hostname, first.address, first.family)
    }
}

interface PinnedDestination {
    url(target: URL): string
    headers(forward: Headers, target: URL): Headers
    serverName: string | null
}

function literalDestination(): PinnedDestination {
    return {
        url: (target) => target.toString(),
        headers: (forward) => forward,
        serverName: null,
    }
}

/**
 * Connect to the address that was checked, not to whatever the name resolves
 * to a moment later (DNS rebinding). The URL carries the IP; `Host` carries
 * the name; `tls.serverName` makes Bun send the right SNI AND verify the
 * certificate against the name.
 *
 * Checked by hand against Bun 1.3.14 (not in the tests, which never open a
 * socket): with `serverName` set to the real host the certificate is verified
 * against it (a wrong `serverName` fails with ERR_TLS_CERT_ALTNAME_INVALID,
 * also after a previous good connection to the same IP), and the default is
 * the URL's IP, which fails too. `tls.checkServerIdentity` is NOT usable for
 * this: Bun 1.3.14 ignores an Error it returns. If a Bun upgrade changes how
 * `serverName` is honoured, the failure mode is a TLS error, not a silent
 * downgrade.
 */
function pinnedDestination(hostname: string, address: string, family: number): PinnedDestination {
    const ipHost = family === 6 ? `[${address}]` : address
    return {
        url: (target) => {
            const pinned = new URL(target.toString())
            pinned.hostname = ipHost
            return pinned.toString()
        },
        headers: (forward, target) => {
            const headers = new Headers(forward)
            headers.set('Host', target.port ? `${hostname}:${target.port}` : hostname)
            return headers
        },
        serverName: hostname,
    }
}

async function readRequestBody(request: Request): Promise<Uint8Array | null> {
    if (!request.body) return null
    const declared = Number(request.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw requestTooLarge()
    const bytes = await readCapped(request.body, MAX_BODY_BYTES)
    if (bytes === null) throw requestTooLarge()
    return bytes
}

function requestTooLarge(): KeychainError {
    return new KeychainError(
        'KEYCHAIN_REQUEST_TOO_LARGE',
        'El cuerpo de la petición pasa de 32 MiB, el máximo que admite el uso de credenciales.'
    )
}

/** Reads a stream up to `max` bytes; null if it is longer (the stream is cancelled). */
export async function readCapped(
    stream: ReadableStream<Uint8Array>,
    max: number
): Promise<Uint8Array | null> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > max) {
            await reader.cancel().catch(() => {})
            return null
        }
        chunks.push(value)
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
    }
    return out
}

async function buildResponse(
    method: string,
    upstream: Response,
    variants: string[]
): Promise<Response> {
    const tooLarge = () =>
        new KeychainError(
            'KEYCHAIN_RESPONSE_TOO_LARGE',
            'La respuesta del destino pasa de 32 MiB y no se puede revisar para ocultar la ' +
                'credencial, así que no se devuelve.'
        )
    const noBody = method === 'HEAD' || [101, 204, 205, 304].includes(upstream.status)
    let body: Uint8Array | null = null
    if (!noBody && upstream.body) {
        // fetch already undid any content-encoding, so content-length (the
        // compressed size) only rules out what is too large even compressed.
        const declared = Number(upstream.headers.get('content-length') ?? '')
        if (!upstream.headers.get('content-encoding') && declared > MAX_BODY_BYTES) {
            await upstream.body.cancel().catch(() => {})
            throw tooLarge()
        }
        body = await readCapped(upstream.body, MAX_BODY_BYTES)
        if (body === null) throw tooLarge()
        body = redactBytes(body, variants)
    } else if (upstream.body) {
        await upstream.body.cancel().catch(() => {})
    }

    const headers = new Headers()
    for (const [name, value] of upstream.headers) {
        const lower = name.toLowerCase()
        if (RESPONSE_DROP.has(lower) || lower === 'set-cookie') continue
        headers.append(name, redactText(value, variants))
    }
    for (const cookie of upstream.headers.getSetCookie()) {
        headers.append('set-cookie', redactText(cookie, variants))
    }
    if (body) headers.set('content-length', String(body.byteLength))

    return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    })
}
