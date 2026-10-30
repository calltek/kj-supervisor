/**
 * Canal de control entre el supervisor y kj-keychain (kj-agent-base
 * `docs/credenciales-por-referencia.md` §7).
 *
 * kj-keychain escucha en `127.0.0.1:KEYCHAIN_CONTROL_PORT` un WebSocket en
 * `/control`; el supervisor se conecta con `Authorization: Bearer <secreto>`
 * (`KJ_KEYCHAIN_CONTROL_SECRET`, que él mismo genera al crear el contenedor).
 * Sólo hay un supervisor conectado a la vez: una conexión nueva sustituye a la
 * anterior.
 *
 * Por aquí el supervisor dice qué token es de qué agente y contesta las
 * referencias que kj-keychain necesita resolver. kj-keychain no habla con el
 * backend: el supervisor añade el turno de la sesión y reenvía
 * `keychain:resolve`.
 */

/** Puerto al que llaman los lanzadores de los agentes (`/r`). */
export const KEYCHAIN_AGENT_PORT = 9890
/** Puerto del canal de control, sólo en 127.0.0.1. */
export const KEYCHAIN_CONTROL_PORT = 9891
/** Nombre del contenedor. */
export const KEYCHAIN_CONTAINER = 'kj-keychain'
/** Comando con el que la imagen del supervisor arranca kj-keychain. */
export const KEYCHAIN_ENTRYPOINT = ['bun', 'src/keychain/main.ts']

/** Un lugar donde se puede usar una credencial (igual que `HostBrowserFillSite`). */
export interface KeychainSite {
    host: string
    subdomains: boolean
}

/** Errores que vienen del backend al resolver una referencia. */
export const KEYCHAIN_RESOLVE_ERROR_CODES = [
    'KEYCHAIN_DISABLED',
    'KEYCHAIN_NOT_FOUND',
    'KEYCHAIN_NO_ACCESS',
    'KEYCHAIN_NO_FIELD',
    'KEYCHAIN_NO_DESTINATION',
    'KEYCHAIN_UNAVAILABLE',
] as const
export type KeychainResolveErrorCode = (typeof KEYCHAIN_RESOLVE_ERROR_CODES)[number]

/** Respuesta de `keychain:resolve` (backend → supervisor → kj-keychain). */
export type KeychainResolveAck =
    | { ok: true; value: string; sites: KeychainSite[] }
    | { ok: false; code: KeychainResolveErrorCode; message: string }

/** Supervisor → kj-keychain. */
export type KeychainControlDown =
    /** Al conectar (y reconectar): la lista entera de agentes vivos. */
    | { type: 'agents:reset'; agents: { agent_id: number; token: string }[] }
    | { type: 'agent:token'; agent_id: number; token: string }
    | { type: 'agent:forget'; agent_id: number }
    | { type: 'resolve:result'; id: string; ack: KeychainResolveAck }

/** kj-keychain → supervisor. */
export type KeychainControlUp = {
    type: 'resolve'
    id: string
    agent_id: number
    conversation_session_id: string
    credential: string
    field: string
}
