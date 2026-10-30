/**
 * SSH through kj-keychain (credenciales-por-referencia.md §2.2, «SSH»). The
 * launcher runs an ssh-agent socket per conversation; for each key the
 * conversation picked it asks here for the public key, and for every
 * signature `ssh` needs it sends the data here. The private key is resolved
 * like any reference (the same backend rules, the same 60 s cache) and never
 * leaves this container: only public keys and signatures go back.
 *
 * - `POST /ssh/key`  `{ credential }` → `{ public_key }` (SSH wire format, base64)
 * - `POST /ssh/sign` `{ credential, public_key, data, flags }` → `{ signature }`
 *
 * Same headers as `/r`: `X-Kj-Token` (the agent) and `X-Kj-Session` (the
 * conversation). No destination check: an SSH key only opens the servers that
 * trust its public key, and the host is not part of what an agent signs.
 */

import type { KeychainResolveAck } from './control-protocol'
import { KeychainError, errorResponse } from './errors'
import type { KeychainLog } from './log'
import type { AgentTokenRegistry } from './registry'
import { CACHE_TTL_MS, type Resolve } from './resolver'
import { type SshKey, SshKeyError, parseSshPrivateKey, signSsh } from './ssh-keys'

export const SSH_KEY_PATH = '/ssh/key'
export const SSH_SIGN_PATH = '/ssh/sign'

/** What `pickReferencedField` matches by type when no label is called that. */
export const SSH_KEY_FIELD = 'ssh_private_key'

const MAX_BODY_BYTES = 64 * 1024
const MAX_NAME = 200

export interface SshHandlerDeps {
    registry: AgentTokenRegistry
    resolve: Resolve
    log: KeychainLog
}

export function isSshPath(path: string): boolean {
    return path === SSH_KEY_PATH || path === SSH_SIGN_PATH
}

export function createSshHandler(deps: SshHandlerDeps) {
    /**
     * Parsed keys by resolved value, as long as the resolve cache keeps the value:
     * parsing an RSA key is not free, and one `ssh` signs more than once.
     */
    const parsed = new Map<string, { key: SshKey; expires: number }>()

    function keyFrom(credential: string, ack: KeychainResolveAck): SshKey {
        if (!ack.ok) throw new KeychainError(ack.code, ack.message)
        const now = Date.now()
        for (const [value, entry] of parsed) if (entry.expires <= now) parsed.delete(value)
        const hit = parsed.get(ack.value)
        if (hit) return hit.key
        try {
            const key = parseSshPrivateKey(ack.value)
            parsed.set(ack.value, { key, expires: now + CACHE_TTL_MS })
            return key
        } catch (error) {
            if (error instanceof SshKeyError && error.reason === 'encrypted') {
                throw new KeychainError(
                    'KEYCHAIN_KEY_ENCRYPTED',
                    `La clave SSH de «${credential}» está protegida con frase de paso y Kujira ` +
                        'todavía no sabe abrirla. Pide al operador que la guarde sin frase en ' +
                        'Credenciales.'
                )
            }
            throw new KeychainError(
                'KEYCHAIN_NOT_SSH_KEY',
                `La credencial «${credential}» no lleva una clave privada SSH que Kujira sepa ` +
                    'usar (ed25519, RSA o ECDSA). Pide al operador que la revise en Credenciales.'
            )
        }
    }

    return async function handleSsh(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname
        let agent_id: number | null = null
        try {
            if (request.method !== 'POST') {
                throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'Sólo POST.', 405)
            }
            agent_id = deps.registry.agentFor(request.headers.get('x-kj-token'))
            if (agent_id === null) {
                throw new KeychainError(
                    'KEYCHAIN_UNAUTHORIZED',
                    'Petición sin un token de agente válido.'
                )
            }
            const session = request.headers.get('x-kj-session')?.trim()
            if (!session) {
                throw new KeychainError(
                    'KEYCHAIN_BAD_REQUEST',
                    'Falta la sesión de la conversación.'
                )
            }
            const body = await readJson(request)
            const credential = typeof body.credential === 'string' ? body.credential.trim() : ''
            if (!credential || credential.length > MAX_NAME) {
                throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'Falta el nombre de la credencial.')
            }
            const key = keyFrom(
                credential,
                await deps.resolve({
                    agent_id,
                    conversation_session_id: session,
                    credential,
                    field: SSH_KEY_FIELD,
                })
            )

            if (path === SSH_KEY_PATH) {
                deps.log('info', 'ssh key', { agent_id })
                return Response.json({ public_key: key.public_blob.toString('base64') })
            }

            // The key the socket listed must still be the one in the credential:
            // if someone changed it meanwhile, signing with the new one would
            // answer for a key ssh did not ask about.
            const wanted = decode(body.public_key)
            if (!wanted?.equals(key.public_blob)) {
                throw new KeychainError(
                    'KEYCHAIN_KEY_CHANGED',
                    `La clave SSH de «${credential}» ha cambiado. Vuelve a elegirla y repite.`
                )
            }
            const data = decode(body.data)
            if (!data || data.length === 0) {
                throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'Faltan los datos a firmar.')
            }
            const flags = Number.isInteger(body.flags) ? (body.flags as number) : 0
            const signature = signSsh(key, data, flags)
            deps.log('info', 'ssh sign', { agent_id })
            return Response.json({ signature: signature.toString('base64') })
        } catch (error) {
            if (error instanceof KeychainError) {
                deps.log('warn', 'ssh refused', {
                    agent_id,
                    code: error.code,
                    status: error.status,
                })
                return errorResponse(error)
            }
            deps.log('error', 'ssh failed', { agent_id })
            return errorResponse(
                new KeychainError(
                    'KEYCHAIN_UNAVAILABLE',
                    'No se ha podido firmar con la clave SSH.'
                )
            )
        }
    }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > MAX_BODY_BYTES) {
        throw new KeychainError('KEYCHAIN_REQUEST_TOO_LARGE', 'Petición demasiado grande.')
    }
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) {
        throw new KeychainError('KEYCHAIN_REQUEST_TOO_LARGE', 'Petición demasiado grande.')
    }
    try {
        const value = JSON.parse(text) as unknown
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>
        }
    } catch {}
    throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'El cuerpo tiene que ser un objeto JSON.')
}

function decode(value: unknown): Buffer | null {
    if (typeof value !== 'string' || !value || value.length > MAX_BODY_BYTES) return null
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
    return Buffer.from(value, 'base64')
}
