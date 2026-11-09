/**
 * Per-agent limits for `/sql` and `/mail`, in memory: how many run at once,
 * and how many mail recipients an hour (the organization's SMTP server is not
 * a free relay: a runaway agent would burn its reputation).
 */

import { KeychainError } from './errors'

export class ConcurrencyLimit {
    private readonly running = new Map<number, number>()

    constructor(
        private readonly max: number,
        private readonly what: string
    ) {}

    /** Takes a slot or refuses; call the function returned when done. */
    acquire(agent_id: number): () => void {
        const now = this.running.get(agent_id) ?? 0
        if (now >= this.max) {
            throw new KeychainError(
                'KEYCHAIN_RATE_LIMITED',
                `Ya hay ${this.max} ${this.what} en curso de este agente. Espera a que acaben.`
            )
        }
        this.running.set(agent_id, now + 1)
        let released = false
        return () => {
            if (released) return
            released = true
            const left = (this.running.get(agent_id) ?? 1) - 1
            if (left <= 0) this.running.delete(agent_id)
            else this.running.set(agent_id, left)
        }
    }
}

/** At most `max` units per agent in any `windowMs`. */
export class WindowQuota {
    private readonly used = new Map<number, { at: number; n: number }[]>()

    constructor(
        private readonly max: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now
    ) {}

    take(agent_id: number, n: number, refuse: () => KeychainError): void {
        const since = this.now() - this.windowMs
        const entries = (this.used.get(agent_id) ?? []).filter((e) => e.at > since)
        const total = entries.reduce((sum, e) => sum + e.n, 0)
        if (total + n > this.max) {
            this.used.set(agent_id, entries)
            throw refuse()
        }
        entries.push({ at: this.now(), n })
        this.used.set(agent_id, entries)
    }
}
