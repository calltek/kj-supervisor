/**
 * Constants for the Claude Code OAuth flow that the supervisor
 * performs on behalf of the control plane. These mirror what the
 * official Claude Code CLI uses — we reuse its public `client_id`
 * so the exchange looks like any other headless `claude
 * setup-token` invocation from this VPS.
 *
 * Do NOT make these env-configurable: if Anthropic ever rotates
 * the client_id we want a single, audited place to bump it.
 */

export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/**
 * Headless redirect URI. claude.ai detects this and shows the code
 * on screen instead of redirecting; the operator copies it from the
 * browser and pastes it back into the Kujira UI, which sends it down
 * for the supervisor to redeem here. MUST match the redirect_uri
 * we pass at /authorize time — the token endpoint compares them
 * byte-for-byte.
 */
export const CLAUDE_OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'

/**
 * NOT `platform.claude.com` — that path returns 400 "Invalid request
 * format" with no further detail. The real exchange endpoint that the
 * Claude Code CLI hits is on `console.anthropic.com`. Verified
 * against the reverse-engineered CLI spec
 * (gist.github.com/changjonathanc/9f9d635b2f8692e0520a884eaf098351).
 */
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token'

/**
 * How long we wait for the token endpoint before giving up and
 * returning a recoverable error. The authorisation code stays valid
 * on Anthropic's side for several minutes, so a failed retry is safe.
 */
export const OAUTH_EXCHANGE_TIMEOUT_MS = 10_000
