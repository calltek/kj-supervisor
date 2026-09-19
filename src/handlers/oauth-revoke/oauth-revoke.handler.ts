/**
 * Handler for `oauth:revoke`. Revokes a Claude subscription token at
 * Anthropic when the control retires it (connection deleted, cleared or
 * reconnected with a new token):
 *
 *   POST https://platform.claude.com/v1/oauth/token/revoke
 *     { token, token_type_hint: 'access_token', client_id: 9d1c250a-… }
 *
 * The same call `claude /logout` makes, from the same kind of place: this VPS,
 * like any headless CLI, rather than a centralised pattern from `kujira.so` —
 * the reason the exchange lives here too.
 *
 * A 200 means the token is no longer valid. Per RFC 7009 Anthropic answers 200
 * for a token it does not know as well, so this cannot tell "revoked now" from
 * "was already dead"; both are what the control wants.
 *
 * The token is never logged — not even a prefix — and never persisted.
 */

import type { KJLogger } from '../../logger'
import {
    CLAUDE_OAUTH_CLIENT_ID,
    CLAUDE_OAUTH_REVOKE_ENDPOINT,
    OAUTH_REVOKE_TIMEOUT_MS,
} from '../../oauth/constants'
import { type OAuthRevokeAck, type OAuthRevokePayload, WS_ERROR_CODES } from '../../protocol'

export interface OAuthRevokeHandlerDeps {
    logger: KJLogger
}

export class OAuthRevokeHandler {
    private readonly logger: KJLogger

    constructor(deps: OAuthRevokeHandlerDeps) {
        this.logger = deps.logger.child({ component: 'oauth-revoke' })
    }

    async handle(payload: OAuthRevokePayload): Promise<OAuthRevokeAck> {
        const { request_id, token } = payload
        if (!token) {
            return {
                ok: false,
                error: {
                    code: WS_ERROR_CODES.INTERNAL_ERROR,
                    message: 'oauth:revoke requires a token',
                    retryable: false,
                },
            }
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), OAUTH_REVOKE_TIMEOUT_MS)
        let response: Response
        try {
            response = await fetch(CLAUDE_OAUTH_REVOKE_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                // JSON, like the exchange. `token_type_hint` is required by this
                // endpoint (400 "Invalid request format" without it), and what
                // Kujira stores is the access token.
                body: JSON.stringify({
                    token,
                    token_type_hint: 'access_token',
                    client_id: CLAUDE_OAUTH_CLIENT_ID,
                }),
                signal: controller.signal,
            })
        } catch (err) {
            const aborted = (err as Error)?.name === 'AbortError'
            this.logger.warn(
                { request_id, err: (err as Error).message, aborted },
                'oauth revoke endpoint unreachable'
            )
            return {
                ok: false,
                error: {
                    code: WS_ERROR_CODES.INTERNAL_ERROR,
                    message: aborted
                        ? `Anthropic did not respond within ${OAUTH_REVOKE_TIMEOUT_MS}ms`
                        : 'Could not reach Anthropic revoke endpoint',
                    retryable: true,
                },
            }
        } finally {
            clearTimeout(timer)
        }

        if (!response.ok) {
            // Only the status: the body of an error page can carry anything,
            // and the control shows this message in the activity log.
            this.logger.warn({ request_id, status: response.status }, 'oauth revoke rejected')
            return {
                ok: false,
                error: {
                    code: WS_ERROR_CODES.INTERNAL_ERROR,
                    message: `Revoke endpoint returned ${response.status}`,
                    retryable: response.status >= 500,
                },
            }
        }

        this.logger.info({ request_id }, 'oauth revoke ok')
        return { ok: true }
    }
}
