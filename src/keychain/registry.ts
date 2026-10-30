/**
 * Agent tokens → agent_id, as the supervisor registers them. Tokens are kept
 * only as SHA-256 digests: a lookup by digest does not compare the secret
 * byte by byte, and a memory dump does not hand out usable tokens.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

function digest(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Constant-time string comparison (both sides hashed first, so lengths match). */
export function safeEqual(a: string, b: string): boolean {
    const da = createHash('sha256').update(a, 'utf8').digest()
    const db = createHash('sha256').update(b, 'utf8').digest()
    return timingSafeEqual(da, db)
}

export class AgentTokenRegistry {
    private readonly agentByDigest = new Map<string, number>()
    private readonly digestByAgent = new Map<number, string>()

    reset(agents: { agent_id: number; token: string }[]): void {
        this.agentByDigest.clear()
        this.digestByAgent.clear()
        for (const { agent_id, token } of agents) this.set(agent_id, token)
    }

    /** Registers or rotates the token of an agent (the old one stops working). */
    set(agent_id: number, token: string): void {
        if (!Number.isInteger(agent_id) || typeof token !== 'string' || !token) return
        this.forget(agent_id)
        const d = digest(token)
        this.agentByDigest.set(d, agent_id)
        this.digestByAgent.set(agent_id, d)
    }

    forget(agent_id: number): void {
        const d = this.digestByAgent.get(agent_id)
        if (d !== undefined) this.agentByDigest.delete(d)
        this.digestByAgent.delete(agent_id)
    }

    agentFor(token: string | null | undefined): number | null {
        if (!token) return null
        return this.agentByDigest.get(digest(token)) ?? null
    }

    agents(): number[] {
        return [...this.digestByAgent.keys()]
    }
}
