/**
 * Handler for `connection:test` — the «Probar» button, for everything the
 * control cannot check from its own network.
 *
 * The control tests what lives on the internet itself. It asks here for the
 * three things it must not, or cannot, call:
 *
 *  - **A Claude subscription.** `GET /v1/models` with `Authorization: Bearer`
 *    does evaluate an OAuth token (an invalid one answers «OAuth access token
 *    is invalid»), so a valid one answers 200. But it leaves from this VPS for
 *    the same reason the exchange and the revocation do: the token belongs to
 *    the customer's CLI, and Anthropic blocks `sk-ant-oat01-*` used outside
 *    it. A centralised pattern from `kujira.so` is how a subscription gets
 *    flagged.
 *  - **A local engine (Ollama)** whose address may be a LAN. The control never
 *    resolves it; this supervisor is already on that network.
 *  - **Anything on a private network**, same reason.
 *
 * **This handler REPORTS, it does not judge.** It hands back the status code,
 * the (capped) body and, for Ollama, the two context numbers — and the control
 * turns that into the sentence a person reads, with the same catalogue it uses
 * for the connections it tests itself. If both sides classified, the same
 * connection would say two different things depending on which path checked
 * it.
 *
 * Like the control's own probe, it **never follows a redirect**: a jump chosen
 * by the other side is a jump nobody checked, and here the other side sits on
 * the customer's own network.
 */

import type { KJLogger } from '../../logger'
import {
    type ConnectionTestAck,
    type ConnectionTestCheck,
    type ConnectionTestResultPayload,
    type OllamaProbeResult,
    WS_ERROR_CODES,
} from '../../protocol'

/** Where a Claude subscription is checked. Not configurable, like the CLI's ids. */
const ANTHROPIC_MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models?limit=1'

/** The API version every Anthropic-shaped endpoint expects. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * How much of a body is read. The control only shows ~280 characters of it,
 * and the address is one the customer typed: without a cap a single press can
 * pull hundreds of megabytes into this container's memory.
 */
const MAX_BODY_BYTES = 32 * 1024

/**
 * How many model names are worth sending back from an Ollama.
 *
 * It is a size guard, not a display limit: the control decides «that model is
 * not downloaded» by looking through this list, so a cap that cut it short
 * would make the control tell someone to `ollama pull` 20 GB of a model they
 * already have. Truncating the list IS a verdict — trimming it for display is
 * the control's job, and it already does that. Whenever the cap bites, the
 * count of what was actually there travels alongside so the control knows it
 * did not see everything.
 */
const MAX_MODELS = 200

export interface ConnectionTestHandlerDeps {
    logger: KJLogger
    /** Injected so the tests do not depend on this machine's network. */
    fetchImpl?: typeof fetch
}

export class ConnectionTestHandler {
    private readonly logger: KJLogger
    private readonly fetchImpl: typeof fetch

    constructor(deps: ConnectionTestHandlerDeps) {
        this.logger = deps.logger.child({ component: 'connection-test' })
        this.fetchImpl = deps.fetchImpl ?? fetch
    }

    async handle(payload: {
        request_id: string
        timeout_ms: number
        check: ConnectionTestCheck
    }): Promise<ConnectionTestAck> {
        const { request_id, check } = payload
        // ONE instant for the whole check, not a fresh budget per request.
        // The Ollama path makes three calls in a row, so a per-request timeout
        // let this handler spend 3 × `timeout_ms` against a control that only
        // waits for 1.5 × — a live-but-slow Ollama (a big model loading makes
        // `/api/show` and `/api/ps` crawl) blew past the control's own
        // deadline, whose `catch` reads as «update your server». The customer
        // would be told to fix a supervisor that is perfectly fine.
        const deadline = Date.now() + (payload.timeout_ms > 0 ? payload.timeout_ms : 10_000)

        try {
            if (check.kind === 'anthropic_oauth') {
                const result = await this.request(
                    ANTHROPIC_MODELS_ENDPOINT,
                    {
                        method: 'GET',
                        headers: {
                            authorization: `Bearer ${check.token}`,
                            'anthropic-version': ANTHROPIC_VERSION,
                        },
                    },
                    deadline
                )
                // Never the token, never the body — only what happened.
                this.logger.info({ request_id, status: result.http_status }, 'subscription checked')
                return { ok: true, result }
            }

            if (check.kind === 'http') {
                const result = await this.request(
                    check.url,
                    {
                        method: check.method ?? 'GET',
                        headers: {
                            ...(check.body !== undefined
                                ? { 'content-type': 'application/json' }
                                : {}),
                            ...check.headers,
                        },
                        ...(check.body !== undefined ? { body: JSON.stringify(check.body) } : {}),
                    },
                    deadline
                )
                this.logger.info({ request_id, status: result.http_status }, 'endpoint checked')
                return { ok: true, result }
            }

            const result = await this.ollama(check.base_url, check.model, deadline)
            this.logger.info(
                { request_id, models: result.ollama?.models.length ?? 0 },
                'engine checked'
            )
            return { ok: true, result }
        } catch (err) {
            // A failure of OURS, not of the connection. The control turns this
            // into "the check could not be run", which sends whoever reads it
            // somewhere other than their own credential.
            //
            // The NAME of the error, not its message: with `kind: 'http'` the
            // headers are composed by the control and can carry the
            // credential, and a message about an invalid header is exactly
            // where one would surface in a log that nobody expects to hold
            // secrets.
            this.logger.error({ request_id, err: (err as Error)?.name }, 'check blew up')
            return {
                ok: false,
                error: {
                    code: WS_ERROR_CODES.INTERNAL_ERROR,
                    message: 'The check could not be run on this server',
                    retryable: true,
                },
            }
        }
    }

    /**
     * One request, against the shared deadline, no redirects, capped body.
     *
     * Never throws for a network failure: not reaching the address IS the
     * answer to the question being asked, so it comes back classified.
     *
     * The abort stays armed **until the body has been read**. Headers arriving
     * fast says nothing about the body: an endpoint that dribbles it out — or
     * simply holds the stream open, which model endpoints do all the time —
     * would leave the read hanging forever, so the handler would never ack and
     * the socket would stay open. The 32 KB cap protects the memory; only the
     * deadline protects the time, and the argument for having it is the same:
     * the address is written by whoever configures the connection.
     */
    private async request(
        url: string,
        init: RequestInit,
        deadline: number
    ): Promise<ConnectionTestResultPayload> {
        const left = deadline - Date.now()
        // The budget is already spent: calling anyway would overrun the
        // control's own deadline, which reads as «update your server».
        if (left <= 0) return { http_status: null, network_error: 'timeout' }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), left)
        try {
            const res = await this.fetchImpl(url, {
                ...init,
                signal: controller.signal,
                redirect: 'manual',
            })

            if (res.status >= 300 && res.status < 400) {
                // Where it points is NOT reported: the destination is chosen
                // by the other side, and this supervisor sits inside the
                // customer's network — echoing it back would be handing out a
                // map of it.
                await res.body?.cancel().catch(() => {})
                return { http_status: res.status, redirected: true }
            }

            return { http_status: res.status, body: await readCapped(res) }
        } catch (err) {
            return { http_status: null, network_error: classifyNetworkError(err) }
        } finally {
            clearTimeout(timer)
        }
    }

    /**
     * What an Ollama says about itself, and the number nobody could see.
     *
     * Three of its endpoints, because one request cannot answer the question
     * that matters:
     *
     *  - `/api/tags` — what is downloaded there. Without it, "the model is not
     *    pulled" is indistinguishable from "the engine is down".
     *  - `/api/show` — the MODEL's own maximum (262.144 on a qwen3-coder).
     *  - `/api/ps` — what the server is actually SERVING for it (`num_ctx`,
     *    4.096 by default unless `OLLAMA_CONTEXT_LENGTH` raises it).
     *
     * The last two together are the point: showing both is what tells the
     * customer their configuration needs changing. Neither is ever written
     * into the connection on its own.
     *
     * Only `/api/tags` decides whether the engine answered; the other two are
     * best-effort. An older Ollama may not report a context length at all, and
     * a model that is not loaded right now has no `/api/ps` entry — neither of
     * those means the connection is broken, so neither is allowed to say so.
     */
    private async ollama(
        base_url: string,
        model: string | null,
        deadline: number
    ): Promise<ConnectionTestResultPayload> {
        const base = base_url.replace(/\/+$/, '')
        const tags = await this.request(`${base}/api/tags`, { method: 'GET' }, deadline)
        if (tags.network_error || tags.redirected) return tags
        if (tags.http_status !== 200) return tags

        const { names, total } = modelNames(tags.body)
        const ollama: OllamaProbeResult = { models: names }
        // Only when the cap actually bit. Sending it always would be noise;
        // sending it here is what stops the control from concluding «that
        // model is not downloaded» out of a list it did not see whole.
        if (total > names.length) ollama.models_total = total
        if (model) {
            ollama.model_max_context = await this.modelMaxContext(base, model, deadline)
            ollama.served_context = await this.servedContext(base, model, deadline)
        }
        return { http_status: 200, ollama }
    }

    /** The model's own maximum, from `/api/show`. Undefined if it cannot be read. */
    private async modelMaxContext(
        base: string,
        model: string,
        deadline: number
    ): Promise<number | undefined> {
        const show = await this.request(
            `${base}/api/show`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model }),
            },
            deadline
        )
        if (show.http_status !== 200) return undefined
        const info = jsonOf(show.body)?.model_info as Record<string, unknown> | undefined
        if (!info) return undefined
        // The key is prefixed with the architecture (`qwen3.context_length`,
        // `llama.context_length`), so it is found by its suffix rather than by
        // guessing the family — a new architecture would silently read as
        // "unknown" otherwise.
        for (const [key, value] of Object.entries(info)) {
            if (key.endsWith('.context_length') && typeof value === 'number') return value
        }
        return undefined
    }

    /** What the server is serving for that model right now, from `/api/ps`. */
    private async servedContext(
        base: string,
        model: string,
        deadline: number
    ): Promise<number | undefined> {
        const ps = await this.request(`${base}/api/ps`, { method: 'GET' }, deadline)
        if (ps.http_status !== 200) return undefined
        const running = jsonOf(ps.body)?.models
        if (!Array.isArray(running)) return undefined
        const bare = (m: string) => m.replace(/:latest$/, '')
        const entry = running.find((m: any) => {
            const name = typeof m?.name === 'string' ? m.name : m?.model
            return typeof name === 'string' && bare(name) === bare(model)
        })
        const ctx = (entry as any)?.context_length
        return typeof ctx === 'number' ? ctx : undefined
    }
}

/** Why there was no response at all. */
function classifyNetworkError(err: unknown): ConnectionTestResultPayload['network_error'] {
    const text = `${(err as Error)?.name ?? ''} ${(err as Error)?.message ?? ''} ${
        ((err as { cause?: Error })?.cause as Error)?.message ?? ''
    }`.toLowerCase()
    if (text.includes('abort') || text.includes('timeout')) return 'timeout'
    if (text.includes('cert') || text.includes('ssl') || text.includes('tls')) return 'tls'
    if (
        text.includes('econnrefused') ||
        text.includes('enotfound') ||
        text.includes('ehostunreach') ||
        text.includes('enetunreach') ||
        text.includes('fetch failed')
    ) {
        return 'unreachable'
    }
    return 'other'
}

/** The body, up to the cap, without ever holding more than that. */
async function readCapped(res: Response): Promise<string> {
    const reader = res.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (size < MAX_BODY_BYTES) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            // Trimmed as it arrives, not at the end: checking before reading
            // meant the buffer could hold 32 KB plus a whole last chunk, and a
            // chunk is whatever the other side decided to send.
            const room = MAX_BODY_BYTES - size
            const piece = value.byteLength > room ? value.subarray(0, room) : value
            chunks.push(piece)
            size += piece.byteLength
        }
    } catch {
        // A cut halfway does not invalidate what was already read.
    } finally {
        await reader.cancel().catch(() => {})
    }
    const joined = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
        joined.set(chunk, at)
        at += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(joined)
}

/** The body as JSON, or undefined. */
function jsonOf(body: string | undefined): Record<string, any> | undefined {
    if (!body) return undefined
    try {
        const parsed = JSON.parse(body)
        return parsed && typeof parsed === 'object' ? parsed : undefined
    } catch {
        return undefined
    }
}

/**
 * The model names in an `/api/tags` body, and how many there were.
 *
 * The count is the point: the control looks through this list to decide «that
 * model is not downloaded», so it has to be able to tell a short list from a
 * shortened one.
 */
function modelNames(body: string | undefined): { names: string[]; total: number } {
    const models = jsonOf(body)?.models
    if (!Array.isArray(models)) return { names: [], total: 0 }
    const all = models
        .map((m: any) => (typeof m?.name === 'string' ? m.name : m?.model))
        .filter((n: unknown): n is string => typeof n === 'string')
    return { names: all.slice(0, MAX_MODELS), total: all.length }
}
