/**
 * A person's web browser in an agent (kj-app docs/navegador-integrado.md
 * §9.4.2): the supervisor only relays, it decides nothing. The control
 * authorizes, the agent's launcher applies the rules of the page.
 *
 *   control → `agent:browser:action` (with an answer) → stdin
 *     `{ type: 'browser', id, user_id, profile, request, approved_key?, budget_ms }`
 *   stdout `{ kj_channel: 'browser', kind: 'result', id, outcome }` → the answer
 *
 *   control → `agent:browser:control` (one way) → stdin
 *     `{ type: 'browser_control', user_id, op, … }`
 *
 *   stdout `{ kj_channel: 'browser', kind: 'frame' | 'state' | 'closed', user_id, … }`
 *     → `agent:browser:frame` / `:state` / `:closed` to the control
 *
 * It is the first channel from the control to the agent with an answer: the
 * others (`skills_changed`, `interrupt`) only go one way.
 *
 * What a person types (`op: 'input'`) can be a password: none of it is logged
 * here, neither the payload nor its fields.
 */
import { randomUUID } from 'node:crypto'

import type { KJLogger } from '../logger'

/** The answer when the agent doesn't answer in time, or isn't there. */
export interface BrowserOutcomeLike {
    status: 'done' | 'failed' | 'denied'
    code?: string
    message?: string
    data?: unknown
}

export interface BrowserActionPayload {
    request_id?: string
    agent_id: number
    user_id: number
    profile: { mode: 'shared' | 'chat' | 'temp'; chat?: string }
    request: Record<string, unknown>
    approved_key?: string
    budget_ms: number
}

export interface BrowserControlPayload {
    agent_id: number
    user_id: number
    op: string
    [k: string]: unknown
}

export type BrowserLine = Record<string, unknown> & { kj_channel: 'browser' }

export function isBrowserLine(line: Record<string, unknown>): line is BrowserLine {
    return line.kj_channel === 'browser'
}

/** The longest an action may wait here, whatever the control asked. */
const MAX_BUDGET_MS = 30_000

/** What the agent's lines may push up: nothing else leaves. */
const PUSHED = {
    frame: 'agent:browser:frame',
    state: 'agent:browser:state',
    closed: 'agent:browser:closed',
}

const validUser = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

interface Pending {
    agent_id: number
    resolve: (o: BrowserOutcomeLike) => void
    timer: ReturnType<typeof setTimeout>
}

export class BrowserRelay {
    private readonly pending = new Map<string, Pending>()

    constructor(
        private readonly deps: {
            /** A control envelope on the agent's stdin; false if there's no stream. */
            write: (agent_id: number, envelope: { type: string; [k: string]: unknown }) => boolean
            push: (event: string, payload: unknown) => void
            logger: KJLogger
        }
    ) {}

    /** Run one action in the agent's browser and wait for its outcome. */
    action(p: BrowserActionPayload): Promise<BrowserOutcomeLike> {
        if (!validUser(p.user_id) || typeof p.request?.kind !== 'string')
            return Promise.resolve(fail('MCP_INVALID_ARGS', 'malformed browser action'))
        const id = randomUUID()
        const budget = Math.min(Math.max(Number(p.budget_ms) || 0, 1_000), MAX_BUDGET_MS)
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                resolve(fail('HOST_BROWSER_TIMEOUT', 'The browser did not answer in time'))
            }, budget)
            this.pending.set(id, { agent_id: p.agent_id, resolve, timer })
            const written = this.deps.write(p.agent_id, {
                type: 'browser',
                id,
                user_id: p.user_id,
                profile: p.profile,
                request: p.request,
                ...(p.approved_key ? { approved_key: p.approved_key } : {}),
                budget_ms: budget,
            })
            if (!written) this.settle(id, fail('AGENT_NOT_RUNNING', 'The agent is not running'))
        })
    }

    /** What the person does with their browser: one way, nothing logged. */
    control(p: BrowserControlPayload): boolean {
        if (!validUser(p.user_id) || typeof p.op !== 'string') return false
        const { agent_id, ...rest } = p
        return this.deps.write(agent_id, { ...rest, type: 'browser_control' })
    }

    /** A `kj_channel: 'browser'` line from an agent's stdout. */
    onContainerLine(agent_id: number, line: BrowserLine): void {
        const kind = line.kind
        if (kind === 'result') {
            const id = typeof line.id === 'string' ? line.id : ''
            const p = this.pending.get(id)
            // Only the agent the action went to may answer it.
            if (!p || p.agent_id !== agent_id) return
            this.settle(id, outcomeOf(line.outcome))
            return
        }
        const event = typeof kind === 'string' ? PUSHED[kind as keyof typeof PUSHED] : undefined
        if (!event || !validUser(line.user_id)) return
        const { kj_channel: _c, kind: _k, ...rest } = line
        this.deps.push(event, { ...rest, agent_id })
    }

    /** The agent's stream went away: whatever it was doing won't answer. */
    onDetach(agent_id: number): void {
        for (const [id, p] of this.pending)
            if (p.agent_id === agent_id)
                this.settle(id, fail('AGENT_NOT_RUNNING', 'The agent stopped'))
    }

    private settle(id: string, o: BrowserOutcomeLike): void {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        clearTimeout(p.timer)
        p.resolve(o)
    }
}

function fail(code: string, message: string): BrowserOutcomeLike {
    return { status: 'failed', code, message }
}

/** The agent's outcome, kept to its shape: anything else is a failure. */
function outcomeOf(v: unknown): BrowserOutcomeLike {
    const o = v as BrowserOutcomeLike | undefined
    if (!o || (o.status !== 'done' && o.status !== 'failed' && o.status !== 'denied'))
        return fail('HOST_BROWSER_FAILED', 'The browser gave no answer')
    return {
        status: o.status,
        ...(typeof o.code === 'string' ? { code: o.code } : {}),
        ...(typeof o.message === 'string' ? { message: o.message } : {}),
        ...(o.data !== undefined ? { data: o.data } : {}),
    }
}
