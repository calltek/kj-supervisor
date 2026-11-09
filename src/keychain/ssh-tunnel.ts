/**
 * An SSH tunnel opened by kj-keychain itself (for `/sql`): it connects to the
 * SSH server, authenticates with a key that never leaves this container, and
 * opens a `direct-tcpip` channel to the database as the SSH server sees it
 * (`ssh -L`). The transport is ours end to end: no byte goes through the
 * agent's container, so the agent cannot stand in for the database and catch
 * the password.
 *
 * The key is signed with `ssh-keys.ts`, the same code as `/ssh/sign`, through
 * an in-process agent: ssh2 never parses the private key itself, so every
 * format `/ssh/key` accepts works here too.
 *
 * There is no known_hosts: kj-keychain keeps no state. The SSH server's host
 * key is not pinned (the first connection of an `ssh` without known_hosts,
 * every time). An impostor in between would not get in with the key (the
 * signature covers the session), but it would see what goes through the
 * tunnel.
 */

import type { Duplex } from 'node:stream'

import { BaseAgent, Client, type ParsedKey } from 'ssh2'

import { SSH_AGENT_RSA_SHA2_256, SSH_AGENT_RSA_SHA2_512, type SshKey, signSsh } from './ssh-keys'

export interface SshTunnelOptions {
    /** The address already checked (never re-resolved here). */
    address: string
    port: number
    username: string
    key: SshKey
    /** Where to, seen from the SSH server. */
    dst_host: string
    dst_port: number
    timeout_ms: number
}

export interface SshTunnel {
    stream: Duplex
    close(): void
}

export type OpenSshTunnel = (options: SshTunnelOptions) => Promise<SshTunnel>

/** Why a tunnel did not open, for the message the agent relays. */
export class SshTunnelError extends Error {
    constructor(
        readonly reason: 'auth' | 'unreachable' | 'timeout' | 'forward',
        message: string
    ) {
        super(message)
    }
}

/** Signs with an `SshKey` in-process, as an ssh-agent would. */
class KeyAgent extends BaseAgent<Buffer> {
    constructor(private readonly key: SshKey) {
        super()
    }

    getIdentities(cb: (err: Error | undefined, keys?: Buffer[]) => void): void {
        cb(undefined, [this.key.public_blob])
    }

    sign(
        _pubKey: Buffer | string | ParsedKey,
        data: Buffer,
        options: unknown,
        cb?: (err: Error | undefined, signature?: Buffer) => void
    ): void {
        const callback = (typeof options === 'function' ? options : cb) as
            | ((err: Error | undefined, signature?: Buffer) => void)
            | undefined
        if (!callback) return
        const hash = (options as { hash?: string } | undefined)?.hash
        const flags =
            hash === 'sha512'
                ? SSH_AGENT_RSA_SHA2_512
                : hash === 'sha256'
                  ? SSH_AGENT_RSA_SHA2_256
                  : 0
        try {
            callback(undefined, innerSignature(signSsh(this.key, data, flags)))
        } catch (error) {
            callback(error instanceof Error ? error : new Error('sign failed'))
        }
    }
}

/** `string format, string blob` → the blob, which is what ssh2 wants from an agent. */
export function innerSignature(blob: Buffer): Buffer {
    const nameLength = blob.readUInt32BE(0)
    const at = 4 + nameLength
    const length = blob.readUInt32BE(at)
    return blob.subarray(at + 4, at + 4 + length)
}

export const openSshTunnel: OpenSshTunnel = (options) =>
    new Promise<SshTunnel>((resolve, reject) => {
        const client = new Client()
        let settled = false
        const fail = (error: SshTunnelError) => {
            if (settled) return
            settled = true
            client.end()
            reject(error)
        }
        client.on('error', (error: Error & { level?: string; code?: string }) => {
            if (error.level === 'client-authentication') {
                fail(new SshTunnelError('auth', 'el servidor SSH no ha aceptado la clave'))
            } else if (error.level === 'client-timeout') {
                fail(new SshTunnelError('timeout', 'el servidor SSH no contesta'))
            } else {
                fail(new SshTunnelError('unreachable', error.code ?? 'conexión fallida'))
            }
        })
        client.on('ready', () => {
            client.forwardOut('127.0.0.1', 0, options.dst_host, options.dst_port, (err, stream) => {
                if (err) {
                    fail(
                        new SshTunnelError(
                            'forward',
                            `el servidor SSH no deja abrir ${options.dst_host}:${options.dst_port}`
                        )
                    )
                    return
                }
                if (settled) {
                    stream.destroy()
                    return
                }
                settled = true
                resolve({
                    stream,
                    close: () => {
                        stream.destroy()
                        client.end()
                    },
                })
            })
        })
        client.on('close', () => {
            fail(new SshTunnelError('unreachable', 'el servidor SSH ha cerrado la conexión'))
        })
        client.connect({
            host: options.address,
            port: options.port,
            username: options.username,
            agent: new KeyAgent(options.key),
            readyTimeout: options.timeout_ms,
            // No known_hosts here (see above).
            hostVerifier: () => true,
            keepaliveInterval: 0,
        })
    })
