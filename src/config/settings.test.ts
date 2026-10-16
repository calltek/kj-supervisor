import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { KJSettings } from './settings'

const KEYS = ['KJ_CONTROL_URL', 'KJ_ALLOW_INSECURE_CONTROL']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
    for (const k of KEYS) {
        saved[k] = process.env[k]
        delete process.env[k]
    }
})

afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
    }
})

function load(url: string, insecure?: string): KJSettings {
    process.env.KJ_CONTROL_URL = url
    if (insecure !== undefined) process.env.KJ_ALLOW_INSECURE_CONTROL = insecure
    return KJSettings.load()
}

describe('KJ_CONTROL_URL', () => {
    test('rejects http to a public host with an actionable message', () => {
        expect(() => load('http://api.ejemplo.com')).toThrow(/KJ_CONTROL_URL must use https/)
        expect(() => load('http://api.ejemplo.com')).toThrow(/KJ_ALLOW_INSECURE_CONTROL=1/)
    })

    test('accepts https', () => {
        expect(load('https://api.kujira.so').control_url).toBe('https://api.kujira.so')
    })

    test.each([
        'http://localhost:5050',
        'http://127.0.0.1:5050',
        'http://[::1]:5050',
        'http://control.localhost:5050',
        'http://host.docker.internal:5050',
    ])('accepts http to the dev host %s', (url) => {
        expect(load(url).control_url).toBe(url)
    })

    test('does not treat a lookalike host as local', () => {
        expect(() => load('http://localhost.evil.com')).toThrow()
        expect(() => load('http://evil.com/localhost')).toThrow()
    })

    test('KJ_ALLOW_INSECURE_CONTROL=1 allows http to any host', () => {
        expect(load('http://api.ejemplo.com', '1').control_url).toBe('http://api.ejemplo.com')
    })

    test('any other value of the escape does not allow it', () => {
        expect(() => load('http://api.ejemplo.com', 'true')).toThrow()
    })

    test('strips the trailing slash', () => {
        expect(load('https://api.kujira.so/').control_url).toBe('https://api.kujira.so')
    })

    test('rejects non-http protocols', () => {
        expect(() => load('ftp://api.kujira.so')).toThrow(/http\(s\)/)
    })
})
