import { describe, expect, test } from 'bun:test'

import { isBlockedAddress } from './addresses'
import { authHeaderValue, extractReferences, mentionsReference, parseReference } from './references'
import { REDACTED, collectVariants, redactBytes, redactText } from './redact'
import { hostMatchesSite } from './sites'

describe('references', () => {
    test('splits on the LAST dot: the credential may have spaces and dots', () => {
        expect(parseReference('Stripe.api_key')).toEqual({ credential: 'Stripe', field: 'api_key' })
        expect(parseReference('Mi cuenta v2.0.Contraseña')).toEqual({
            credential: 'Mi cuenta v2.0',
            field: 'Contraseña',
        })
        expect(parseReference('sinpunto')).toBeNull()
        expect(parseReference('.campo')).toBeNull()
        expect(parseReference('cred.')).toBeNull()
    })

    test('extracts every reference in a header value', () => {
        const refs = extractReferences('Basic {{kj:A b.user}}:{{kj:A b.pass}}')
        expect(refs?.map((r) => [r.credential, r.field])).toEqual([
            ['A b', 'user'],
            ['A b', 'pass'],
        ])
    })

    test('a malformed reference is not silently left in place', () => {
        expect(extractReferences('Bearer {{kj:nodot}}')).toBeNull()
        expect(extractReferences('Bearer {{ kj:Stripe.api_key }}')).toBeNull()
    })

    test('detects references raw and percent-encoded', () => {
        expect(mentionsReference('https://x.com/?q={{kj:S.k}}')).toBe(true)
        expect(mentionsReference('https://x.com/?q=%7B%7Bkj%3AS.k%7D%7D')).toBe(true)
        expect(mentionsReference('{"a":"{{ KJ :S.k}}"}')).toBe(true)
        expect(mentionsReference('https://x.com/?q=hola')).toBe(false)
    })
})

describe('sites', () => {
    const site = { host: 'wallapop.com', subdomains: true }

    test('exact host and subdomains', () => {
        expect(hostMatchesSite('wallapop.com', site)).toBe(true)
        expect(hostMatchesSite('api.wallapop.com', site)).toBe(true)
        expect(hostMatchesSite('API.Wallapop.com.', site)).toBe(true)
    })

    test('a look-alike domain does not match', () => {
        expect(hostMatchesSite('evil-wallapop.com', site)).toBe(false)
        expect(hostMatchesSite('wallapop.com.evil.com', site)).toBe(false)
        expect(hostMatchesSite('evilwallapop.com', site)).toBe(false)
    })

    test('without subdomains only the exact host matches', () => {
        const exact = { host: 'api.stripe.com', subdomains: false }
        expect(hostMatchesSite('api.stripe.com', exact)).toBe(true)
        expect(hostMatchesSite('x.api.stripe.com', exact)).toBe(false)
        expect(hostMatchesSite('stripe.com', exact)).toBe(false)
    })
})

describe('blocked addresses', () => {
    test.each([
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '255.255.255.255',
        '::',
        '::1',
        'fe80::1',
        'fe80::1%eth0',
        'fc00::1',
        'fd00:ec2::254',
        'ff02::1',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '::ffff:169.254.169.254',
        '[::ffff:10.0.0.1]',
        '64:ff9b::a00:1',
        '2002:c0a8:0101::1',
        '2001:0:4136:e378::1',
        'not-an-ip',
    ])('%s is blocked', (address) => {
        expect(isBlockedAddress(address)).toBe(true)
    })

    test.each([
        '8.8.8.8',
        '1.1.1.1',
        '172.32.0.1',
        '100.128.0.1',
        '2606:4700:4700::1111',
        '::ffff:8.8.8.8',
        '64:ff9b::808:808',
    ])('%s is allowed', (address) => {
        expect(isBlockedAddress(address)).toBe(false)
    })
})

describe('redaction', () => {
    const secret = 'sk_live_Ab+/c d?é'

    test('hides the value as written, base64 (standard and url-safe) and url-encoded', () => {
        const variants = collectVariants([secret])
        const b64 = Buffer.from(secret).toString('base64')
        const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        for (const form of [secret, b64, b64url, encodeURIComponent(secret)]) {
            const out = redactText(`before ${form} after`, variants)
            expect(out).toBe(`before ${REDACTED} after`)
        }
    })

    test('hides the value inside a longer base64 string (Basic auth)', () => {
        const basic = Buffer.from(`user:${secret}`).toString('base64')
        const out = redactText(basic, collectVariants([secret]))
        expect(out).toContain(REDACTED)
        expect(out).not.toContain(basic)
    })

    test('short values are hidden too', () => {
        expect(redactText('pin=1234;', collectVariants(['1234']))).toBe(`pin=${REDACTED};`)
    })

    test('works on bytes and leaves the rest of a binary body intact', () => {
        const body = new Uint8Array([0xff, 0x00, ...Buffer.from(secret), 0xfe])
        const out = redactBytes(body, collectVariants([secret]))
        expect(Array.from(out.slice(0, 2))).toEqual([0xff, 0x00])
        expect(Array.from(out.slice(-1))).toEqual([0xfe])
        expect(Buffer.from(out.slice(2, -1)).toString()).toBe(REDACTED)
    })
})

describe('basic auth', () => {
    const values = new Map([['{{kj:Jira.password}}', 's3cret:pass']])

    test('encodes the plain pair after substituting', () => {
        const out = authHeaderValue('Authorization', 'Basic ana:{{kj:Jira.password}}', values)
        expect(out.value).toBe(`Basic ${Buffer.from('ana:s3cret:pass').toString('base64')}`)
        expect(out.plain).toBe('ana:s3cret:pass')
    })

    test('a Bearer or an already encoded Basic is only substituted', () => {
        expect(authHeaderValue('Authorization', 'Bearer {{kj:Jira.password}}', values).value).toBe(
            'Bearer s3cret:pass'
        )
        expect(authHeaderValue('Authorization', 'Basic YWJjZA==', values).value).toBe(
            'Basic YWJjZA=='
        )
    })

    test('only in the auth headers', () => {
        expect(authHeaderValue('X-API-Key', 'Basic a:{{kj:Jira.password}}', values).value).toBe(
            'Basic a:s3cret:pass'
        )
    })
})
