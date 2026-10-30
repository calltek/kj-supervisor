import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import pino from 'pino'

import { KJLogger, REDACT_PATHS } from '../logger'
import {
    KEYCHAIN_AGENT_PORT,
    KEYCHAIN_CONTAINER,
    KEYCHAIN_CONTROL_PORT,
    type KeychainControlDown,
} from '../keychain/control-protocol'
import { KJ_LABEL } from '../docker/client/client'
import type { ControlSocket } from './keychain-control-channel'
import { buildKeychainContainerSpec, keychainControlUrl } from './keychain-container'
import {
    KEYCHAIN_ENDPOINT_ENV,
    KEYCHAIN_TOKEN_ENV,
    KeychainHost,
    type KeychainDocker,
    type KeychainResolvePayload,
} from './keychain-host'

/** A logger whose every line ends up in `out`, with the production redaction. */
function capturingLogger(): { logger: KJLogger; out: () => string } {
    let out = ''
    const sink = new Writable({
        write(chunk, _enc, done) {
            out += chunk.toString()
            done()
        },
    })
    const p = pino({ level: 'debug', redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink)
    return { logger: new KJLogger(p), out: () => out }
}

class FakeSocket implements ControlSocket {
    readyState = 0
    sent: KeychainControlDown[] = []
    onopen: ((ev: unknown) => void) | null = null
    onclose: ((ev: unknown) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    send(data: string): void {
        this.sent.push(JSON.parse(data))
    }
    close(): void {
        this.readyState = 3
    }
    open(): void {
        this.readyState = 1
        this.onopen?.({})
    }
}

class FakeDocker implements KeychainDocker {
    own: { image: string; network_mode?: string } | null = {
        image: 'sha256:supervisor',
        network_mode: 'host',
    }
    gateway: string | null = '172.17.0.1'
    desktop = false
    created: any[] = []
    replaceError: Error | null = null
    envs = new Map<string, string[]>()
    live: Array<{ container_id: string; agent_id: number | null }> = []
    async inspectOwnContainer() {
        return this.own
    }
    async bridgeGateway() {
        return this.gateway
    }
    async isDockerDesktop() {
        return this.desktop
    }
    async replaceContainer(spec: any) {
        if (this.replaceError) throw this.replaceError
        this.created.push(spec)
        return 'kc1'
    }
    async listKjContainers() {
        return this.live
    }
    async inspect(id: string) {
        return { Config: { Env: this.envs.get(id) ?? [] }, State: { Running: true } }
    }
}

function setup(
    opts: {
        sessions?: Record<number, Record<string, { turn_id?: string; turn_request_ids?: string[] }>>
        upstream?: (p: KeychainResolvePayload) => Promise<unknown>
    } = {}
) {
    const docker = new FakeDocker()
    const { logger, out } = capturingLogger()
    const sockets: FakeSocket[] = []
    const upstreamCalls: KeychainResolvePayload[] = []
    const host = new KeychainHost({
        docker,
        logger,
        sessions: (agent_id, sid) => opts.sessions?.[agent_id]?.[sid] ?? null,
        resolve: async (p) => {
            upstreamCalls.push(p)
            return opts.upstream ? opts.upstream(p) : { ok: true, value: 'v', sites: [] }
        },
        socketFactory: () => {
            const s = new FakeSocket()
            sockets.push(s)
            return s
        },
    })
    return { docker, host, out, sockets, upstreamCalls }
}

describe('el contenedor de kj-keychain', () => {
    const spec = buildKeychainContainerSpec({
        image: 'sha256:abc',
        control_secret: 'secret',
        agent_host_ip: '172.17.0.1',
    }) as any

    test('no lleva la etiqueta de agente: la reconciliación no lo ve', () => {
        expect(Object.keys(spec.Labels)).not.toContain(KJ_LABEL)
        expect(spec.Labels['kj-keychain']).toBe('true')
    })

    test('sin capacidades, sin escalar, raíz de sólo lectura y nada montado', () => {
        expect(spec.HostConfig.CapDrop).toEqual(['ALL'])
        expect(spec.HostConfig.SecurityOpt).toContain('no-new-privileges')
        expect(spec.HostConfig.ReadonlyRootfs).toBe(true)
        expect(spec.HostConfig.CapAdd).toBeUndefined()
        expect(spec.HostConfig.Privileged).toBeUndefined()
        expect(spec.HostConfig.Mounts).toEqual([])
        expect(spec.HostConfig.Binds).toEqual([])
        expect(spec.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' })
        expect(spec.HostConfig.Memory).toBeGreaterThan(0)
    })

    test('agentes en la pasarela del bridge; control sólo en loopback', () => {
        const pb = spec.HostConfig.PortBindings
        expect(pb[`${KEYCHAIN_AGENT_PORT}/tcp`]).toEqual([
            { HostIp: '172.17.0.1', HostPort: String(KEYCHAIN_AGENT_PORT) },
        ])
        expect(pb[`${KEYCHAIN_CONTROL_PORT}/tcp`]).toEqual([
            { HostIp: '127.0.0.1', HostPort: String(KEYCHAIN_CONTROL_PORT) },
        ])
        // Nada en 0.0.0.0.
        for (const bindings of Object.values(pb) as any[])
            for (const b of bindings) expect(b.HostIp).not.toBe('')
    })

    test('misma imagen, su propio comando y su nombre; el secreto va en el entorno', () => {
        expect(spec.Image).toBe('sha256:abc')
        expect(spec.name).toBe(KEYCHAIN_CONTAINER)
        expect(spec.Entrypoint).toEqual(['bun', 'src/keychain/main.ts'])
        expect(spec.Env).toContain('KJ_KEYCHAIN_CONTROL_SECRET=secret')
    })

    test('el supervisor llega al control por loopback en red de host, si no por host.docker.internal', () => {
        expect(keychainControlUrl('host')).toBe(`ws://127.0.0.1:${KEYCHAIN_CONTROL_PORT}/control`)
        expect(keychainControlUrl('bridge')).toBe(
            `ws://host.docker.internal:${KEYCHAIN_CONTROL_PORT}/control`
        )
    })

    test('con la IP de kj-keychain en la bridge, por ella, sea cual sea la red del supervisor', () => {
        // bigbrain corre el supervisor en la bridge: el 127.0.0.1 del host no le llega.
        for (const mode of ['host', 'bridge', undefined]) {
            expect(keychainControlUrl(mode, '172.17.0.5')).toBe(
                `ws://172.17.0.5:${KEYCHAIN_CONTROL_PORT}/control`
            )
        }
    })
})

describe('KeychainHost.start', () => {
    test('crea kj-keychain con la imagen propia y la pasarela del bridge', async () => {
        const { docker, host } = setup()
        await host.start()
        expect(docker.created).toHaveLength(1)
        expect(docker.created[0].Image).toBe('sha256:supervisor')
        expect(
            docker.created[0].HostConfig.PortBindings[`${KEYCHAIN_AGENT_PORT}/tcp`][0].HostIp
        ).toBe('172.17.0.1')
        host.stop()
    })

    test('sin pasarela, o en Docker Desktop, el puerto de agentes va a loopback', async () => {
        for (const tweak of [
            (d: FakeDocker) => {
                d.gateway = null
            },
            (d: FakeDocker) => {
                d.desktop = true
            },
        ]) {
            const { docker, host } = setup()
            tweak(docker)
            await host.start()
            expect(
                docker.created[0].HostConfig.PortBindings[`${KEYCHAIN_AGENT_PORT}/tcp`][0].HostIp
            ).toBe('127.0.0.1')
            host.stop()
        }
    })

    test('fuera de Docker no arranca nada, y no lanza', async () => {
        const { docker, host, sockets } = setup()
        docker.own = null
        await host.start()
        expect(docker.created).toHaveLength(0)
        expect(sockets).toHaveLength(0)
    })

    test('un fallo creando el contenedor no tumba el supervisor', async () => {
        const { docker, host } = setup()
        docker.replaceError = new Error('boom')
        await expect(host.start()).resolves.toBeUndefined()
    })

    test('recupera los tokens de los agentes vivos y los manda en agents:reset al conectar', async () => {
        const { docker, host, sockets } = setup()
        docker.live = [
            { container_id: 'a', agent_id: 7 },
            { container_id: 'b', agent_id: null },
        ]
        docker.envs.set('a', ['FOO=1', `${KEYCHAIN_TOKEN_ENV}=tok7`])
        await host.start()
        sockets[0]!.open()
        expect(sockets[0]!.sent).toEqual([
            { type: 'agents:reset', agents: [{ agent_id: 7, token: 'tok7' }] },
        ])
        host.stop()
    })
})

describe('tokens por agente', () => {
    test('envFor da un token nuevo de 32 bytes y el endpoint, y lo registra', async () => {
        const { host, sockets } = setup()
        await host.start()
        sockets[0]!.open()
        const env = host.envFor(3)
        expect(env[KEYCHAIN_TOKEN_ENV]).toMatch(/^[0-9a-f]{64}$/)
        expect(env[KEYCHAIN_ENDPOINT_ENV]).toBe(
            `http://host.docker.internal:${KEYCHAIN_AGENT_PORT}`
        )
        expect(host.envFor(3)[KEYCHAIN_TOKEN_ENV]).not.toBe(env[KEYCHAIN_TOKEN_ENV])
        expect(sockets[0]!.sent.filter((m) => m.type === 'agent:token')).toHaveLength(2)
        host.stop()
    })

    test('adopt lee el token del entorno (recreate, reinicio) sin repetirlo; forget lo quita', async () => {
        const { docker, host, sockets } = setup()
        await host.start()
        sockets[0]!.open()
        docker.envs.set('c', [`${KEYCHAIN_TOKEN_ENV}=tokC`])
        await host.adopt(5, 'c')
        await host.adopt(5, 'c')
        host.forget(5)
        expect(sockets[0]!.sent.slice(1)).toEqual([
            { type: 'agent:token', agent_id: 5, token: 'tokC' },
            { type: 'agent:forget', agent_id: 5 },
        ])
        expect(host.knownAgents()).toEqual([])
        host.stop()
    })

    test('el token no sale en ningún log', async () => {
        const { docker, host, sockets, out } = setup()
        docker.live = [{ container_id: 'a', agent_id: 1 }]
        docker.envs.set('a', [`${KEYCHAIN_TOKEN_ENV}=zzz-token-vivo-zzz`])
        await host.start()
        sockets[0]!.open()
        const fresh = host.envFor(2)[KEYCHAIN_TOKEN_ENV]!
        expect(out()).not.toContain('zzz-token-vivo-zzz')
        expect(out()).not.toContain(fresh)
        host.stop()
    })
})

describe('resolve', () => {
    const SESSION = '11111111-1111-1111-1111-111111111111'

    async function started(o: Parameters<typeof setup>[0]) {
        const s = setup(o)
        s.docker.live = [
            { container_id: 'a', agent_id: 1 },
            { container_id: 'b', agent_id: 2 },
        ]
        s.docker.envs.set('a', [`${KEYCHAIN_TOKEN_ENV}=t1`])
        s.docker.envs.set('b', [`${KEYCHAIN_TOKEN_ENV}=t2`])
        await s.host.start()
        s.sockets[0]!.open()
        return s
    }

    const msg = (agent_id: number, session = SESSION) => ({
        type: 'resolve' as const,
        id: 'r1',
        agent_id,
        conversation_session_id: session,
        credential: 'Stripe',
        field: 'api_key',
    })

    test('una sesión que el agente no tiene no llega al control', async () => {
        const s = await started({ sessions: { 1: { [SESSION]: {} } } })
        await s.host.onMessage(msg(2)) // la sesión es del agente 1
        await s.host.onMessage(msg(1, 'otra-sesion')) // inventada
        expect(s.upstreamCalls).toEqual([])
        const results = s.sockets[0]!.sent.filter((m) => m.type === 'resolve:result')
        expect(results).toHaveLength(2)
        for (const r of results)
            expect(r).toMatchObject({ ack: { ok: false, code: 'KEYCHAIN_NO_ACCESS' } })
        s.host.stop()
    })

    test('un agente sin token registrado tampoco', async () => {
        const s = await started({ sessions: { 9: { [SESSION]: {} } } })
        await s.host.onMessage(msg(9))
        expect(s.upstreamCalls).toEqual([])
        s.host.stop()
    })

    test('una sesión del agente va al control con su turno y vuelve el ack, sin loguear el valor', async () => {
        const s = await started({
            sessions: { 1: { [SESSION]: { turn_id: 'turn-1', turn_request_ids: ['req-1'] } } },
            upstream: async () => ({
                ok: true,
                value: 'zzz-valor-secreto-zzz',
                sites: [{ host: 'api.stripe.com', subdomains: false }],
            }),
        })
        await s.host.onMessage(msg(1))
        expect(s.upstreamCalls).toEqual([
            {
                agent_id: 1,
                conversation_session_id: SESSION,
                turn_id: 'turn-1',
                turn_request_ids: ['req-1'],
                credential: 'Stripe',
                field: 'api_key',
            },
        ])
        const result = s.sockets[0]!.sent.find((m) => m.type === 'resolve:result')
        expect(result).toEqual({
            type: 'resolve:result',
            id: 'r1',
            ack: {
                ok: true,
                value: 'zzz-valor-secreto-zzz',
                sites: [{ host: 'api.stripe.com', subdomains: false }],
            },
        })
        expect(s.out()).not.toContain('zzz-valor-secreto-zzz')
        s.host.stop()
    })

    test('si el control no contesta, KEYCHAIN_UNAVAILABLE', async () => {
        const s = await started({
            sessions: { 1: { [SESSION]: {} } },
            upstream: async () => {
                throw new Error('ack timeout')
            },
        })
        const ack = await s.host.handleResolve(msg(1))
        expect(ack).toMatchObject({ ok: false, code: 'KEYCHAIN_UNAVAILABLE' })
        s.host.stop()
    })
})
