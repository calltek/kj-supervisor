import { describe, expect, test } from 'bun:test'

import { NDJSONStreamParser } from './stream-parser'

function collect() {
    const events: Record<string, unknown>[] = []
    const skips: Array<{ reason: string; line: string }> = []
    const parser = new NDJSONStreamParser({
        onEvent: (event) => events.push(event),
        onSkip: (reason, line) => skips.push({ reason, line }),
    })
    return { parser, events, skips }
}

describe('NDJSONStreamParser', () => {
    test('dispatches one event per JSON line', () => {
        const { parser, events } = collect()
        parser.push('{"type":"a"}\n{"type":"b"}\n')
        expect(events).toEqual([{ type: 'a' }, { type: 'b' }])
    })

    test('holds a partial line across chunks until newline arrives', () => {
        const { parser, events } = collect()
        parser.push('{"typ')
        parser.push('e":"a"}\n')
        expect(events).toEqual([{ type: 'a' }])
    })

    test('flushes a trailing line on end()', () => {
        const { parser, events } = collect()
        parser.push('{"type":"a"}')
        parser.end()
        expect(events).toEqual([{ type: 'a' }])
    })

    test('skips empty lines silently', () => {
        const { parser, events, skips } = collect()
        parser.push('\n\n{"type":"a"}\n')
        expect(events).toEqual([{ type: 'a' }])
        expect(skips.map((s) => s.reason)).toEqual(['empty_line', 'empty_line'])
    })

    test('skips and reports malformed JSON, then keeps parsing', () => {
        const { parser, events, skips } = collect()
        parser.push('not-json\n{"type":"a"}\n')
        expect(events).toEqual([{ type: 'a' }])
        expect(skips).toHaveLength(1)
        expect(skips[0]?.reason).toBe('invalid_json')
    })

    test('tolerates a truncated last line (no trailing newline) on end()', () => {
        const { parser, events, skips } = collect()
        parser.push('{"type":"a"}\n{"type":"truncate')
        parser.end()
        expect(events).toEqual([{ type: 'a' }])
        expect(skips.map((s) => s.reason)).toEqual(['invalid_json'])
    })

    test('accepts Buffer chunks as well as strings', () => {
        const { parser, events } = collect()
        parser.push(Buffer.from('{"type":"a"}\n', 'utf8'))
        expect(events).toEqual([{ type: 'a' }])
    })
})
