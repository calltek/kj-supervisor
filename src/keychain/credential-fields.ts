/**
 * Reading the fields of a credential by the usual names (`/sql`, `/mail`).
 * Each name goes through the same resolver as a `{{kj:…}}` reference, so the
 * backend applies the same rules (and `pickReferencedField` matches a type too:
 * `password`, `username`). The first name that exists wins.
 *
 * The backend refuses every field but an SSH key when the credential has no
 * destination: that comes back as `no_destination`, not as an error, because
 * the caller words it with the host it was going to connect to.
 */

import type { KeychainSite } from './control-protocol'
import { KeychainError } from './errors'
import type { Resolve } from './resolver'
import { describeSites, hostMatchesAnySite } from './sites'

export const FIELD_LABELS = {
    host: ['host', 'hostname', 'server', 'database_host', 'db_host'],
    port: ['port', 'database_port', 'db_port'],
    user: ['user', 'username', 'database_user', 'db_user'],
    password: ['password', 'database_password', 'db_password', 'pass'],
    database: ['database', 'dbname', 'database_name', 'db_name'],
    smtp_host: ['host', 'hostname', 'server', 'smtp_host', 'smtp_server'],
    smtp_port: ['port', 'smtp_port'],
    smtp_user: ['user', 'username', 'smtp_user', 'email'],
    smtp_password: ['password', 'smtp_password', 'pass'],
    from: ['from', 'from_email', 'sender'],
} as const

export type FieldLookup =
    | { status: 'found'; value: string; sites: KeychainSite[]; recipients?: string[] }
    | { status: 'absent' }
    | { status: 'no_destination' }

export interface CredentialRef {
    agent_id: number
    conversation_session_id: string
    credential: string
}

/**
 * The first of `labels` the credential has. All are asked at once; any error
 * other than "no such field" or "no destination" stops the request.
 */
export async function lookupField(
    resolve: Resolve,
    ref: CredentialRef,
    labels: readonly string[]
): Promise<FieldLookup> {
    const acks = await Promise.all(labels.map((field) => resolve({ ...ref, field })))
    let noDestination = false
    for (const ack of acks) {
        if (ack.ok) {
            return {
                status: 'found',
                value: ack.value,
                sites: ack.sites,
                recipients: ack.recipients,
            }
        }
        if (ack.code === 'KEYCHAIN_NO_FIELD') continue
        if (ack.code === 'KEYCHAIN_NO_DESTINATION') {
            noDestination = true
            continue
        }
        throw new KeychainError(ack.code, ack.message)
    }
    return noDestination ? { status: 'no_destination' } : { status: 'absent' }
}

/** A port from the body or a credential field; null when there is none. */
export function parsePort(value: unknown, where: string): number | null {
    if (value === undefined || value === null || value === '') return null
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new KeychainError('KEYCHAIN_BAD_REQUEST', `El puerto de ${where} no es válido.`)
    }
    return n
}

function requestDestination(credential: string, host: string | null): string {
    return host
        ? `Llama a credential_request_destination con la credencial «${credential}» y el host ` +
              `${host}: la persona recibe una tarjeta para permitirlo y luego lo repites. No ` +
              'lo intentes por otro camino.'
        : `Llama a credential_request_destination con la credencial «${credential}» y el host ` +
              'al que te conectas: la persona recibe una tarjeta para permitirlo y luego lo ' +
              'repites. No lo intentes por otro camino.'
}

export function noDestinationError(credential: string, host: string | null): KeychainError {
    return new KeychainError(
        'KEYCHAIN_NO_DESTINATION',
        `La credencial «${credential}» no tiene ningún destino configurado, así que no se ` +
            `puede usar${host ? ` en ${host}` : ''}. ${requestDestination(credential, host)}`
    )
}

/**
 * The secret may only go to `host` (the first hop: the SSH server when
 * tunnelled, the server itself otherwise) if it is one of its destinations.
 */
export function assertDestination(credential: string, host: string, sites: KeychainSite[]): void {
    if (!sites.length) throw noDestinationError(credential, host)
    if (!hostMatchesAnySite(host, sites)) {
        throw new KeychainError(
            'KEYCHAIN_WRONG_SITE',
            `La credencial «${credential}» sólo se puede usar en ${describeSites(sites)}, no en ` +
                `${host}. No se ha conectado. Si ese host también es suyo, ` +
                requestDestination(credential, host).replace(/^Llama/, 'llama')
        )
    }
}
