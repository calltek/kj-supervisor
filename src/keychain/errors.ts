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
    | 'KEYCHAIN_WRONG_RECIPIENT'
    | 'KEYCHAIN_UPSTREAM_FAILED'
    | 'KEYCHAIN_RESPONSE_TOO_LARGE'
    | 'KEYCHAIN_NOT_SSH_KEY'
    | 'KEYCHAIN_KEY_ENCRYPTED'
    | 'KEYCHAIN_KEY_CHANGED'
    | 'KEYCHAIN_NOT_TAILNET'
    | 'KEYCHAIN_NOT_VPN_KEY'
    | 'KEYCHAIN_TUNNEL_FAILED'
    | 'KEYCHAIN_SSH_FAILED'
    | 'KEYCHAIN_DB_AUTH_FAILED'
    | 'KEYCHAIN_DB_UNREACHABLE'
    | 'KEYCHAIN_DB_TIMEOUT'
    | 'KEYCHAIN_SQL_ERROR'
    | 'KEYCHAIN_SMTP_AUTH_FAILED'
    | 'KEYCHAIN_SMTP_FAILED'
    | 'KEYCHAIN_MAIL_REJECTED'
    | 'KEYCHAIN_DB_TLS_REQUIRED'
    | 'KEYCHAIN_RATE_LIMITED'
    | 'KEYCHAIN_GOOGLE_TOKEN_FAILED'
    | 'KEYCHAIN_GOOGLE_NOT_ALLOWED'
    | 'KEYCHAIN_IMAP_AUTH_FAILED'
    | 'KEYCHAIN_IMAP_FAILED'

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
    KEYCHAIN_WRONG_RECIPIENT: 403,
    KEYCHAIN_UPSTREAM_FAILED: 502,
    KEYCHAIN_RESPONSE_TOO_LARGE: 502,
    KEYCHAIN_NOT_SSH_KEY: 422,
    KEYCHAIN_KEY_ENCRYPTED: 422,
    KEYCHAIN_KEY_CHANGED: 409,
    KEYCHAIN_NOT_TAILNET: 400,
    KEYCHAIN_NOT_VPN_KEY: 422,
    KEYCHAIN_TUNNEL_FAILED: 502,
    KEYCHAIN_SSH_FAILED: 502,
    KEYCHAIN_DB_AUTH_FAILED: 502,
    KEYCHAIN_DB_UNREACHABLE: 502,
    KEYCHAIN_DB_TIMEOUT: 504,
    KEYCHAIN_SQL_ERROR: 422,
    KEYCHAIN_SMTP_AUTH_FAILED: 502,
    KEYCHAIN_SMTP_FAILED: 502,
    KEYCHAIN_MAIL_REJECTED: 422,
    KEYCHAIN_DB_TLS_REQUIRED: 502,
    KEYCHAIN_RATE_LIMITED: 429,
    KEYCHAIN_GOOGLE_TOKEN_FAILED: 502,
    KEYCHAIN_GOOGLE_NOT_ALLOWED: 403,
    KEYCHAIN_IMAP_AUTH_FAILED: 502,
    KEYCHAIN_IMAP_FAILED: 502,
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
