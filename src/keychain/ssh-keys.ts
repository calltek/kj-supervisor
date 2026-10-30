/**
 * SSH private keys for kj-keychain's signer (credenciales-por-referencia.md
 * §2.2, «SSH»): the agent runs `ssh` against an agent socket of its launcher,
 * and the signatures are made here, so the key never enters the agent's
 * container.
 *
 * Reads the OpenSSH format (`BEGIN OPENSSH PRIVATE KEY`) and PEM (PKCS#1,
 * PKCS#8, SEC1) for ed25519, RSA and ECDSA (nistp256/384/521). A key encrypted
 * with a passphrase is refused with its own error: there is no passphrase to
 * open it with. Pure, with no I/O: tested against keys made by `ssh-keygen`.
 */

import { type KeyObject, createPrivateKey, createPublicKey, sign } from 'node:crypto'

export class SshKeyError extends Error {
    constructor(
        readonly reason: 'not_a_key' | 'encrypted' | 'unsupported',
        message: string
    ) {
        super(message)
    }
}

type Curve = 'nistp256' | 'nistp384' | 'nistp521'

const CURVES: Record<Curve, { jwk: string; size: number; hash: string }> = {
    nistp256: { jwk: 'P-256', size: 32, hash: 'sha256' },
    nistp384: { jwk: 'P-384', size: 48, hash: 'sha384' },
    nistp521: { jwk: 'P-521', size: 66, hash: 'sha512' },
}

const CURVE_BY_JWK: Record<string, Curve> = {
    'P-256': 'nistp256',
    'P-384': 'nistp384',
    'P-521': 'nistp521',
}

export interface SshKey {
    kind: 'ed25519' | 'rsa' | 'ecdsa'
    curve?: Curve
    key: KeyObject
    /** The public key in SSH wire format (what `REQUEST_IDENTITIES` lists). */
    public_blob: Buffer
}

/** ssh-agent `SIGN_REQUEST` flags. */
export const SSH_AGENT_RSA_SHA2_256 = 2
export const SSH_AGENT_RSA_SHA2_512 = 4

// ── SSH wire format ──────────────────────────────────────────────────────

class Reader {
    private offset = 0

    constructor(private readonly buf: Buffer) {}

    uint32(): number {
        if (this.offset + 4 > this.buf.length) throw notAKey()
        const value = this.buf.readUInt32BE(this.offset)
        this.offset += 4
        return value
    }

    bytes(): Buffer {
        const length = this.uint32()
        if (this.offset + length > this.buf.length) throw notAKey()
        const out = this.buf.subarray(this.offset, this.offset + length)
        this.offset += length
        return out
    }

    text(): string {
        return this.bytes().toString('latin1')
    }
}

export function sshString(data: Buffer | string): Buffer {
    const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    return Buffer.concat([head, body])
}

/** A positive integer as an SSH mpint (minimal, a 0x00 in front if the top bit is set). */
function mpint(unsigned: Buffer): Buffer {
    let start = 0
    while (start < unsigned.length && unsigned[start] === 0) start++
    let body = unsigned.subarray(start)
    if (body.length > 0 && (body[0] as number) & 0x80)
        body = Buffer.concat([Buffer.from([0]), body])
    return sshString(body)
}

/** An mpint read back as unsigned big-endian, without the sign byte. */
function unsigned(mp: Buffer): Buffer {
    let start = 0
    while (start < mp.length - 1 && mp[start] === 0) start++
    return mp.subarray(start)
}

function padTo(buf: Buffer, size: number): Buffer {
    if (buf.length > size) throw notAKey()
    return Buffer.concat([Buffer.alloc(size - buf.length), buf])
}

function b64url(buf: Buffer): string {
    return buf.toString('base64url')
}

function bigint(buf: Buffer): bigint {
    return buf.length ? BigInt(`0x${buf.toString('hex')}`) : 0n
}

function fromBigint(value: bigint): Buffer {
    let hex = value.toString(16)
    if (hex.length % 2) hex = `0${hex}`
    return Buffer.from(hex, 'hex')
}

function notAKey(): SshKeyError {
    return new SshKeyError('not_a_key', 'not an SSH private key')
}

// ── Parsing ──────────────────────────────────────────────────────────────

const OPENSSH_MAGIC = Buffer.from('openssh-key-v1\0', 'latin1')

export function parseSshPrivateKey(text: string): SshKey {
    const trimmed = text.trim()
    if (trimmed.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) return parseOpenSsh(trimmed)
    if (/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(trimmed)) return parsePem(trimmed)
    throw notAKey()
}

function parseOpenSsh(text: string): SshKey {
    const body = text.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '')
    const raw = Buffer.from(body, 'base64')
    if (!raw.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) throw notAKey()
    const r = new Reader(raw.subarray(OPENSSH_MAGIC.length))
    const cipher = r.text()
    r.text() // kdf name
    r.bytes() // kdf options
    if (cipher !== 'none') {
        throw new SshKeyError('encrypted', 'the key is protected with a passphrase')
    }
    if (r.uint32() !== 1) throw new SshKeyError('unsupported', 'more than one key in the file')
    r.bytes() // public key (rebuilt from the private part below)
    const p = new Reader(r.bytes())
    // Two equal check words open the private section.
    const check = p.uint32()
    if (check !== p.uint32()) throw notAKey()
    const type = p.text()

    if (type === 'ssh-ed25519') {
        const pub = p.bytes()
        const priv = p.bytes()
        if (pub.length !== 32 || priv.length !== 64) throw notAKey()
        return fromKeyObject(
            createPrivateKey({
                key: {
                    kty: 'OKP',
                    crv: 'Ed25519',
                    d: b64url(priv.subarray(0, 32)),
                    x: b64url(pub),
                },
                format: 'jwk',
            })
        )
    }
    if (type === 'ssh-rsa') {
        const n = unsigned(p.bytes())
        const e = unsigned(p.bytes())
        const d = unsigned(p.bytes())
        const iqmp = unsigned(p.bytes())
        const pp = unsigned(p.bytes())
        const q = unsigned(p.bytes())
        const dn = bigint(d)
        return fromKeyObject(
            createPrivateKey({
                key: {
                    kty: 'RSA',
                    n: b64url(n),
                    e: b64url(e),
                    d: b64url(d),
                    p: b64url(pp),
                    q: b64url(q),
                    dp: b64url(fromBigint(dn % (bigint(pp) - 1n))),
                    dq: b64url(fromBigint(dn % (bigint(q) - 1n))),
                    qi: b64url(iqmp),
                },
                format: 'jwk',
            })
        )
    }
    const ecdsa = /^ecdsa-sha2-(nistp256|nistp384|nistp521)$/.exec(type)
    if (ecdsa) {
        const curve = ecdsa[1] as Curve
        const { jwk, size } = CURVES[curve]
        if (p.text() !== curve) throw notAKey()
        const point = p.bytes()
        const d = unsigned(p.bytes())
        if (point.length !== 1 + 2 * size || point[0] !== 4) throw notAKey()
        return fromKeyObject(
            createPrivateKey({
                key: {
                    kty: 'EC',
                    crv: jwk,
                    x: b64url(point.subarray(1, 1 + size)),
                    y: b64url(point.subarray(1 + size)),
                    d: b64url(padTo(d, size)),
                },
                format: 'jwk',
            })
        )
    }
    throw new SshKeyError('unsupported', `key type ${type} is not supported`)
}

function parsePem(text: string): SshKey {
    if (/ENCRYPTED/.test(text)) {
        throw new SshKeyError('encrypted', 'the key is protected with a passphrase')
    }
    let key: KeyObject
    try {
        key = createPrivateKey({ key: text, format: 'pem' })
    } catch {
        throw notAKey()
    }
    return fromKeyObject(key)
}

function fromKeyObject(key: KeyObject): SshKey {
    const jwk = createPublicKey(key).export({ format: 'jwk' }) as Record<string, string>
    const type = key.asymmetricKeyType
    if (type === 'ed25519') {
        return {
            kind: 'ed25519',
            key,
            public_blob: Buffer.concat([
                sshString('ssh-ed25519'),
                sshString(Buffer.from(jwk.x as string, 'base64url')),
            ]),
        }
    }
    if (type === 'rsa') {
        return {
            kind: 'rsa',
            key,
            public_blob: Buffer.concat([
                sshString('ssh-rsa'),
                mpint(Buffer.from(jwk.e as string, 'base64url')),
                mpint(Buffer.from(jwk.n as string, 'base64url')),
            ]),
        }
    }
    if (type === 'ec') {
        const curve = CURVE_BY_JWK[jwk.crv as string]
        if (!curve) throw new SshKeyError('unsupported', `curve ${jwk.crv} is not supported`)
        const { size } = CURVES[curve]
        const point = Buffer.concat([
            Buffer.from([4]),
            padTo(Buffer.from(jwk.x as string, 'base64url'), size),
            padTo(Buffer.from(jwk.y as string, 'base64url'), size),
        ])
        return {
            kind: 'ecdsa',
            curve,
            key,
            public_blob: Buffer.concat([
                sshString(`ecdsa-sha2-${curve}`),
                sshString(curve),
                sshString(point),
            ]),
        }
    }
    throw new SshKeyError('unsupported', `key type ${type} is not supported`)
}

// ── Signing ──────────────────────────────────────────────────────────────

/**
 * The signature blob an ssh-agent returns in `SIGN_RESPONSE`. For RSA the
 * flags pick the hash; with none, plain `ssh-rsa` (SHA-1), as OpenSSH does.
 */
export function signSsh(key: SshKey, data: Buffer, flags = 0): Buffer {
    if (key.kind === 'ed25519') {
        return Buffer.concat([sshString('ssh-ed25519'), sshString(sign(null, data, key.key))])
    }
    if (key.kind === 'rsa') {
        const [name, hash] =
            flags & SSH_AGENT_RSA_SHA2_512
                ? ['rsa-sha2-512', 'sha512']
                : flags & SSH_AGENT_RSA_SHA2_256
                  ? ['rsa-sha2-256', 'sha256']
                  : ['ssh-rsa', 'sha1']
        return Buffer.concat([sshString(name), sshString(sign(hash, data, key.key))])
    }
    const { size, hash } = CURVES[key.curve as Curve]
    const raw = sign(hash, data, { key: key.key, dsaEncoding: 'ieee-p1363' })
    const inner = Buffer.concat([mpint(raw.subarray(0, size)), mpint(raw.subarray(size))])
    return Buffer.concat([sshString(`ecdsa-sha2-${key.curve}`), sshString(inner)])
}
