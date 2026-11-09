/**
 * What every JSON endpoint of kj-keychain does first (`/ssh/*`, `/sql`,
 * `/mail`): POST only, the agent by its `X-Kj-Token`, the conversation by its
 * `X-Kj-Session`, and a JSON object as body, capped.
 */

import { KeychainError } from './errors'
import type { AgentTokenRegistry } from './registry'

export interface AgentCaller {
    agent_id: number
    session: string
}

export function authenticate(request: Request, registry: AgentTokenRegistry): AgentCaller {
    if (request.method !== 'POST') {
        throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'Sólo POST.', 405)
    }
    const agent_id = registry.agentFor(request.headers.get('x-kj-token'))
    if (agent_id === null) {
        throw new KeychainError('KEYCHAIN_UNAUTHORIZED', 'Petición sin un token de agente válido.')
    }
    const session = request.headers.get('x-kj-session')?.trim()
    if (!session) {
        throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'Falta la sesión de la conversación.')
    }
    return { agent_id, session }
}

export async function readJsonObject(
    request: Request,
    maxBytes: number
): Promise<Record<string, unknown>> {
    const tooLarge = () =>
        new KeychainError('KEYCHAIN_REQUEST_TOO_LARGE', 'Petición demasiado grande.')
    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > maxBytes) throw tooLarge()
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooLarge()
    try {
        const value = JSON.parse(text) as unknown
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>
        }
    } catch {}
    throw new KeychainError('KEYCHAIN_BAD_REQUEST', 'El cuerpo tiene que ser un objeto JSON.')
}

/** The credential named in the body, trimmed; required. */
export function credentialName(value: unknown, what = 'la credencial'): string {
    const name = typeof value === 'string' ? value.trim() : ''
    if (!name || name.length > 200) {
        throw new KeychainError('KEYCHAIN_BAD_REQUEST', `Falta el nombre de ${what}.`)
    }
    return name
}
