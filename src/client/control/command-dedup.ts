/**
 * Idempotency guard for control → supervisor commands.
 *
 * Every command carries a `request_id` (mandatory in the protocol). When
 * the control's planned command-outbox retries an at-least-once command
 * (because an ack was lost but the command already ran), the supervisor
 * MUST NOT execute it twice — a retried `agent:spawn` must not spawn a
 * second container. This remembers the ack of the first execution per
 * `request_id` and replays it for any repeat, so a retry is a safe no-op
 * that still returns the same ack the control expects.
 *
 * In-memory by design: the dedup window only has to cover the retry
 * horizon (seconds), not the supervisor's whole lifetime. After a
 * supervisor restart the map is empty — fine, because the control
 * reconciles agent state on reconnect (`agent:sync`), so a lost dedup
 * entry can't cause lasting drift. Bounded by size + TTL so it can't grow
 * without limit on a long-lived supervisor.
 */

interface Entry {
    ack: unknown
    /** Wall-clock ms when this entry was recorded; for TTL eviction. */
    at: number
}

export interface CommandDedupOptions {
    /** Max distinct request_ids kept. Oldest evicted past this. */
    maxEntries?: number
    /** How long (ms) a remembered ack stays valid. */
    ttlMs?: number
    /** Injectable clock for tests (defaults to Date.now). */
    now?: () => number
}

export class CommandDedup {
    private readonly entries = new Map<string, Entry>()
    private readonly maxEntries: number
    private readonly ttlMs: number
    private readonly now: () => number

    constructor(opts: CommandDedupOptions = {}) {
        this.maxEntries = opts.maxEntries ?? 2_000
        this.ttlMs = opts.ttlMs ?? 5 * 60_000 // 5 min covers any sane retry window
        this.now = opts.now ?? (() => Date.now())
    }

    /**
     * If this request_id was already handled (within the TTL), return the
     * remembered ack — the caller replays it WITHOUT re-running the
     * handler. Returns `undefined` for a first-seen id (caller runs the
     * handler then calls `remember`).
     */
    seen(request_id: string): { ack: unknown } | undefined {
        const hit = this.entries.get(request_id)
        if (!hit) return undefined
        if (this.now() - hit.at > this.ttlMs) {
            this.entries.delete(request_id)
            return undefined
        }
        return { ack: hit.ack }
    }

    /** Record the ack of a freshly-executed command for future replays. */
    remember(request_id: string, ack: unknown): void {
        this.entries.set(request_id, { ack, at: this.now() })
        if (this.entries.size > this.maxEntries) {
            // Map preserves insertion order → first key is the oldest.
            const oldest = this.entries.keys().next().value
            if (oldest !== undefined) this.entries.delete(oldest)
        }
    }
}

/**
 * Pull a `request_id` off an arbitrary command payload. Commands all
 * carry one; if a (legacy / malformed) payload lacks it, return
 * undefined and the caller skips dedup (runs the handler) rather than
 * risk collapsing distinct commands under a shared empty key.
 */
export function requestIdOf(payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'request_id' in payload) {
        const id = (payload as { request_id?: unknown }).request_id
        if (typeof id === 'string' && id.length > 0) return id
    }
    return undefined
}
