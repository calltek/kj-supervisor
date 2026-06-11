import { describe, expect, test } from 'bun:test'
import { isMutableTag } from './image-tag'

describe('isMutableTag', () => {
    test('rolling tags are mutable → pull fresh', () => {
        expect(isMutableTag('ghcr.io/calltek/kj-agent-base:latest')).toBe(true)
        expect(isMutableTag('kj-agent-base:dev')).toBe(true)
        expect(isMutableTag('img:main')).toBe(true)
        expect(isMutableTag('img:edge')).toBe(true)
        expect(isMutableTag('img:nightly')).toBe(true)
    })

    test('no tag defaults to latest → mutable', () => {
        expect(isMutableTag('ghcr.io/calltek/kj-agent-base')).toBe(true)
        expect(isMutableTag('kj-agent-base')).toBe(true)
    })

    test('pinned versions are immutable → cache OK', () => {
        expect(isMutableTag('ghcr.io/calltek/kj-agent-flex:0.1.0')).toBe(false)
        expect(isMutableTag('img:1.2.3')).toBe(false)
        expect(isMutableTag('img:sha-abc123')).toBe(false)
        expect(isMutableTag('img:v2.0.0')).toBe(false)
    })

    test('locally-built tags are immutable → cache (never in a registry)', () => {
        expect(isMutableTag('kj-agent-base:dev-local')).toBe(false)
        expect(isMutableTag('kj-supervisor:local')).toBe(false)
    })

    test('a registry host with a port is not mistaken for a tag', () => {
        // The `:5000` is the registry port, the real tag is `0.1.0`.
        expect(isMutableTag('localhost:5000/kj-agent:0.1.0')).toBe(false)
        // …and `:latest` after the port is still mutable.
        expect(isMutableTag('localhost:5000/kj-agent:latest')).toBe(true)
        // host:port with no image tag → defaults to latest → mutable.
        expect(isMutableTag('localhost:5000/kj-agent')).toBe(true)
    })
})
