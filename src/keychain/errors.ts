/**
 * kj-keychain's own errors: JSON `{ error: { code, message } }` plus the
 * `X-Kj-Keychain-Error` header, so the launcher and the agent can tell them
 * apart from whatever the destination answers. Messages are in Spanish: the
 * agent relays them to the operator.
 */

import type { KeychainResolveErrorCode } from './control-protocol'

export type KeychainErrorCode =
    | KeychainResolveErrorCode
    | 'KEYCHAIN_UNAUTHORIZED'
    | 'KEYCHAIN_BAD_REQUEST'
    | 'KEYCHAIN_NOT_HTTPS'
    | 'KEYCHAIN_NO_REFERENCE'
    | 'KEYCHAIN_BAD_REFERENCE'
    | 'KEYCHAIN_REF_OUTSIDE_HEADER'
    | 'KEYCHAIN_REQUEST_TOO_LARGE'
    | 'KEYCHAIN_PRIVATE_ADDRESS'
    | 'KEYCHAIN_DNS_FAILED'
    | 'KEYCHAIN_WRONG_SITE'
    | 'KEYCHAIN_UPSTREAM_FAILED'
    | 'KEYCHAIN_RESPONSE_TOO_LARGE'

const STATUS: Record<KeychainErrorCode, number> = {
    KEYCHAIN_UNAUTHORIZED: 401,
    KEYCHAIN_BAD_REQUEST: 400,
    KEYCHAIN_NOT_HTTPS: 400,
    KEYCHAIN_NO_REFERENCE: 400,
    KEYCHAIN_BAD_REFERENCE: 400,
    KEYCHAIN_REF_OUTSIDE_HEADER: 400,
    KEYCHAIN_REQUEST_TOO_LARGE: 413,
    KEYCHAIN_PRIVATE_ADDRESS: 403,
    KEYCHAIN_DNS_FAILED: 502,
    KEYCHAIN_WRONG_SITE: 403,
    KEYCHAIN_UPSTREAM_FAILED: 502,
    KEYCHAIN_RESPONSE_TOO_LARGE: 502,
    KEYCHAIN_DISABLED: 403,
    KEYCHAIN_NOT_FOUND: 404,
    KEYCHAIN_NO_ACCESS: 403,
    KEYCHAIN_NO_FIELD: 404,
    KEYCHAIN_NO_DESTINATION: 403,
    KEYCHAIN_UNAVAILABLE: 503,
}

export const KEYCHAIN_ERROR_HEADER = 'X-Kj-Keychain-Error'

export class KeychainError extends Error {
    constructor(
        readonly code: KeychainErrorCode,
        message: string,
        readonly status: number = STATUS[code]
    ) {
        super(message)
    }
}

export function errorResponse(error: KeychainError): Response {
    return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { [KEYCHAIN_ERROR_HEADER]: error.code } }
    )
}
