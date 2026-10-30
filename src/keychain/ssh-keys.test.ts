import { describe, expect, test } from 'bun:test'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'

import {
    SSH_AGENT_RSA_SHA2_256,
    SSH_AGENT_RSA_SHA2_512,
    SshKeyError,
    parseSshPrivateKey,
    signSsh,
    sshString,
} from './ssh-keys'

// Keys are generated here, never committed: a private key in the repo, even a
// test one, trips gitleaks. Checked against ssh-keygen by hand when written
// (SSHSIG signatures made with signSsh verify with `ssh-keygen -Y`).

function strings(buf: Buffer): Buffer[] {
    const out: Buffer[] = []
    let o = 0
    while (o < buf.length) {
        const n = buf.readUInt32BE(o)
        out.push(buf.subarray(o + 4, o + 4 + n))
        o += 4 + n
    }
    return out
}

const b = (s: string) => Buffer.from(s, 'base64url')

function mp(buf: Buffer): Buffer {
    return (buf[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf
}

const CURVE_NAME: Record<string, string> = {
    'P-256': 'nistp256',
    'P-384': 'nistp384',
    'P-521': 'nistp521',
}

/** The OpenSSH container `ssh-keygen` writes, unencrypted unless a cipher is named. */
function openssh(jwk: Record<string, string>, cipher = 'none'): string {
    let pub: Buffer[]
    let priv: Buffer[]
    if (jwk.kty === 'OKP') {
        pub = [Buffer.from('ssh-ed25519'), b(jwk.x as string)]
        priv = [...pub, Buffer.concat([b(jwk.d as string), b(jwk.x as string)])]
    } else if (jwk.kty === 'RSA') {
        pub = [Buffer.from('ssh-rsa'), mp(b(jwk.e as string)), mp(b(jwk.n as string))]
        priv = [
            Buffer.from('ssh-rsa'),
            mp(b(jwk.n as string)),
            mp(b(jwk.e as string)),
            mp(b(jwk.d as string)),
            mp(b(jwk.qi as string)),
            mp(b(jwk.p as string)),
            mp(b(jwk.q as string)),
        ]
    } else {
        const curve = CURVE_NAME[jwk.crv as string] as string
        const point = Buffer.concat([Buffer.from([4]), b(jwk.x as string), b(jwk.y as string)])
        pub = [Buffer.from(`ecdsa-sha2-${curve}`), Buffer.from(curve), point]
        priv = [...pub, mp(b(jwk.d as string))]
    }
    const checkint = Buffer.from([1, 2, 3, 4, 1, 2, 3, 4])
    const section = Buffer.concat([checkint, ...priv.map(sshString), sshString('comment')])
    const body = Buffer.concat([
        Buffer.from('openssh-key-v1\0', 'latin1'),
        sshString(cipher),
        sshString(cipher === 'none' ? 'none' : 'bcrypt'),
        sshString(''),
        Buffer.from([0, 0, 0, 1]),
        sshString(Buffer.concat(pub.map(sshString))),
        sshString(section),
    ])
    return [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        body.toString('base64'),
        '-----END OPENSSH PRIVATE KEY-----',
        '',
    ].join('\n')
}

const RSA_HASH: Record<string, string> = {
    'rsa-sha2-512': 'sha512',
    'rsa-sha2-256': 'sha256',
    'ssh-rsa': 'sha1',
}
const EC: Record<string, { crv: string; size: number; hash: string }> = {
    nistp256: { crv: 'P-256', size: 32, hash: 'sha256' },
    nistp384: { crv: 'P-384', size: 48, hash: 'sha384' },
    nistp521: { crv: 'P-521', size: 66, hash: 'sha512' },
}

/** Verifies an SSH signature blob against the SSH public blob, as a server would. */
function check(publicBlob: Buffer, signature: Buffer, data: Buffer): string {
    const [type, ...rest] = strings(publicBlob) as Buffer[]
    const [sigType, sig] = strings(signature) as [Buffer, Buffer]
    const name = (type as Buffer).toString()
    const u = (x: Buffer) => (x[0] === 0 ? x.subarray(1) : x).toString('base64url')
    let ok: boolean
    if (name === 'ssh-ed25519') {
        const key = createPublicKey({
            key: {
                kty: 'OKP',
                crv: 'Ed25519',
                // Raw 32 bytes, not an mpint: a leading zero is part of the key.
                x: (rest[0] as Buffer).toString('base64url'),
            },
            format: 'jwk',
        })
        ok = verify(null, data, key, sig)
    } else if (name === 'ssh-rsa') {
        const key = createPublicKey({
            key: { kty: 'RSA', e: u(rest[0] as Buffer), n: u(rest[1] as Buffer) },
            format: 'jwk',
        })
        ok = verify(RSA_HASH[sigType.toString()] as string, data, key, sig)
    } else {
        const { crv, size, hash } = EC[(rest[0] as Buffer).toString()] as {
            crv: string
            size: number
            hash: string
        }
        const point = rest[1] as Buffer
        const key = createPublicKey({
            key: {
                kty: 'EC',
                crv,
                x: point.subarray(1, 1 + size).toString('base64url'),
                y: point.subarray(1 + size).toString('base64url'),
            },
            format: 'jwk',
        })
        const [r, s] = strings(sig) as [Buffer, Buffer]
        const fix = (n: Buffer) => {
            const v = n[0] === 0 ? n.subarray(1) : n
            return Buffer.concat([Buffer.alloc(size - v.length), v])
        }
        ok = verify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, Buffer.concat([fix(r), fix(s)]))
    }
    expect(ok).toBe(true)
    return sigType.toString()
}

const DATA = Buffer.from('session id + userauth request')

const PAIRS = {
    ed25519: generateKeyPairSync('ed25519'),
    rsa: generateKeyPairSync('rsa', { modulusLength: 2048 }),
    p256: generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    p384: generateKeyPairSync('ec', { namedCurve: 'P-384' }),
    p521: generateKeyPairSync('ec', { namedCurve: 'P-521' }),
}

describe('parseSshPrivateKey + signSsh', () => {
    for (const [name, pair] of Object.entries(PAIRS)) {
        test(`${name}: OpenSSH and PEM give the same public key, and the signature verifies`, () => {
            const jwk = pair.privateKey.export({ format: 'jwk' }) as Record<string, string>
            const fromOpenSsh = parseSshPrivateKey(openssh(jwk))
            const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
            const fromPem = parseSshPrivateKey(pem)
            expect(fromOpenSsh.public_blob.equals(fromPem.public_blob)).toBe(true)
            check(fromOpenSsh.public_blob, signSsh(fromOpenSsh, DATA, SSH_AGENT_RSA_SHA2_512), DATA)
        })
    }

    test('RSA: the flags pick the hash, SHA-1 without them', () => {
        const key = parseSshPrivateKey(
            PAIRS.rsa.privateKey.export({ format: 'pem', type: 'pkcs1' }) as string
        )
        expect(check(key.public_blob, signSsh(key, DATA, SSH_AGENT_RSA_SHA2_512), DATA)).toBe(
            'rsa-sha2-512'
        )
        expect(check(key.public_blob, signSsh(key, DATA, SSH_AGENT_RSA_SHA2_256), DATA)).toBe(
            'rsa-sha2-256'
        )
        expect(check(key.public_blob, signSsh(key, DATA), DATA)).toBe('ssh-rsa')
    })

    test('SEC1 EC keys too', () => {
        const key = parseSshPrivateKey(
            PAIRS.p256.privateKey.export({ format: 'pem', type: 'sec1' }) as string
        )
        expect(key.curve).toBe('nistp256')
    })

    test('a key with a passphrase says so', () => {
        const jwk = PAIRS.ed25519.privateKey.export({ format: 'jwk' }) as Record<string, string>
        const reason = (text: string) => {
            try {
                parseSshPrivateKey(text)
            } catch (e) {
                return (e as SshKeyError).reason
            }
            return null
        }
        expect(reason(openssh(jwk, 'aes256-ctr'))).toBe('encrypted')
        expect(
            reason(
                PAIRS.rsa.privateKey.export({
                    format: 'pem',
                    type: 'pkcs8',
                    cipher: 'aes-256-cbc',
                    passphrase: 'frase',
                }) as string
            )
        ).toBe('encrypted')
    })

    test('anything else is not a key', () => {
        for (const text of [
            '',
            'hunter2',
            PAIRS.rsa.publicKey.export({ format: 'pem', type: 'spki' }) as string,
            '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
        ]) {
            expect(() => parseSshPrivateKey(text)).toThrow(SshKeyError)
        }
    })
})
