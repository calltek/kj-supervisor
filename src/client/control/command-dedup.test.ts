import { describe, expect, test } from 'bun:test'
import { CommandDedup, requestIdOf } from './command-dedup'

describe('CommandDedup', () => {
    test('first sight of a request_id is a miss', () => {
        const d = new CommandDedup()
        expect(d.seen('req-1')).toBeUndefined()
    })

    test('after remember, the same id replays the stored ack', () => {
        const d = new CommandDedup()
        const ack = { ok: true, accepted: true }
        expect(d.seen('req-1')).toBeUndefined()
        d.remember('req-1', ack)
        expect(d.seen('req-1')).toEqual({ ack })
    })

    test('distinct ids do not collide', () => {
        const d = new CommandDedup()
        d.remember('a', 1)
        d.remember('b', 2)
        expect(d.seen('a')).toEqual({ ack: 1 })
        expect(d.seen('b')).toEqual({ ack: 2 })
    })

    test('an entry expires after the TTL', () => {
        let now = 1_000
        const d = new CommandDedup({ ttlMs: 100, now: () => now })
        d.remember('req-1', 'ack')
        now = 1_050
        expect(d.seen('req-1')).toEqual({ ack: 'ack' }) // within TTL
        now = 1_200
        expect(d.seen('req-1')).toBeUndefined() // past TTL → evicted
    })

    test('evicts the oldest entry past maxEntries', () => {
        const d = new CommandDedup({ maxEntries: 2 })
        d.remember('a', 1)
        d.remember('b', 2)
        d.remember('c', 3) // pushes 'a' out
        expect(d.seen('a')).toBeUndefined()
        expect(d.seen('b')).toEqual({ ack: 2 })
        expect(d.seen('c')).toEqual({ ack: 3 })
    })
})

describe('requestIdOf', () => {
    test('extracts a non-empty string request_id', () => {
        expect(requestIdOf({ request_id: 'abc', agent_id: 5 })).toBe('abc')
    })

    test('returns undefined when absent, empty, or non-string', () => {
        expect(requestIdOf({ agent_id: 5 })).toBeUndefined()
        expect(requestIdOf({ request_id: '' })).toBeUndefined()
        expect(requestIdOf({ request_id: 42 })).toBeUndefined()
        expect(requestIdOf(null)).toBeUndefined()
        expect(requestIdOf('not-an-object')).toBeUndefined()
    })
})
