/**
 * The kj-keychain container, as this supervisor creates it (kj-agent-base
 * `docs/credenciales-por-referencia.md` §2.1 and §7).
 *
 * Pure on purpose: what this container may touch is the whole point of moving
 * credential use out of the agent, so the spec is built in one function a test
 * can read whole.
 *
 * - **Never the `kj-agent` label.** Reconciliation (`listKjContainers`), the
 *   events watcher and `server:hello` all select by it: with it, the control
 *   would see kj-keychain as an orphan agent and stop it, and a `die` would be
 *   reported as an agent's status. It carries its own label instead.
 * - **Nothing mounted**: no `docker.sock`, no agent volume, no config dir.
 *   Breaking into it yields the credentials cached at that moment, not the
 *   machine.
 * - **No capabilities, no privilege escalation, read-only root.** Bun writes
 *   nothing but `/tmp`; its transpiler cache is switched off so it doesn't try
 *   to write one under a read-only home.
 * - **Two ports, two addresses.** The agents' port goes on the gateway of the
 *   default bridge (what `host.docker.internal:host-gateway` resolves to in an
 *   agent), so it is reachable from the containers and not from the internet.
 *   The control port only on loopback. Without a bridge gateway (Docker
 *   Desktop, where `host.docker.internal` IS the host's loopback) both go on
 *   127.0.0.1.
 */

import type Docker from 'dockerode'

import {
    KEYCHAIN_AGENT_PORT,
    KEYCHAIN_CONTAINER,
    KEYCHAIN_CONTROL_PORT,
    KEYCHAIN_ENTRYPOINT,
} from '../keychain/control-protocol'

/** Label kj-keychain carries instead of `kj-agent`. */
export const KEYCHAIN_LABEL = 'kj-keychain'
/** Env var with the control secret, read by kj-keychain at boot. */
export const KEYCHAIN_SECRET_ENV = 'KJ_KEYCHAIN_CONTROL_SECRET'
/** Memory cap. It holds a cache of a few strings and proxies HTTP: 256 MiB is plenty. */
export const KEYCHAIN_MEMORY_BYTES = 256 * 1024 * 1024
/** Loopback, where the control port always goes. */
export const LOOPBACK = '127.0.0.1'

export interface KeychainContainerOptions {
    /** The supervisor's own image (id or tag): kj-keychain runs the same code. */
    image: string
    /** Fresh per creation, kept only in the supervisor's memory. */
    control_secret: string
    /** Where the agents' port is published: the bridge gateway, or loopback. */
    agent_host_ip: string
}

export function buildKeychainContainerSpec(
    opts: KeychainContainerOptions
): Docker.ContainerCreateOptions {
    const agentPort = `${KEYCHAIN_AGENT_PORT}/tcp`
    const controlPort = `${KEYCHAIN_CONTROL_PORT}/tcp`
    return {
        name: KEYCHAIN_CONTAINER,
        Image: opts.image,
        Entrypoint: [...KEYCHAIN_ENTRYPOINT],
        // The image's own Cmd would be appended to the entrypoint.
        Cmd: [],
        Env: [
            `${KEYCHAIN_SECRET_ENV}=${opts.control_secret}`,
            // Read-only root: no transpiler cache on disk.
            'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0',
        ],
        Labels: { [KEYCHAIN_LABEL]: 'true' },
        ExposedPorts: { [agentPort]: {}, [controlPort]: {} },
        HostConfig: {
            NetworkMode: 'bridge',
            PortBindings: {
                [agentPort]: [
                    { HostIp: opts.agent_host_ip, HostPort: String(KEYCHAIN_AGENT_PORT) },
                ],
                [controlPort]: [{ HostIp: LOOPBACK, HostPort: String(KEYCHAIN_CONTROL_PORT) }],
            },
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            ReadonlyRootfs: true,
            Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
            RestartPolicy: { Name: 'unless-stopped' },
            Memory: KEYCHAIN_MEMORY_BYTES,
            Mounts: [],
            Binds: [],
        },
    }
}

/**
 * Where the supervisor reaches the control port. Best by kj-keychain's own
 * address on the bridge: the supervisor reaches it there whether it runs on the
 * host network or on the bridge itself (bigbrain runs it on the bridge, and
 * from there the port published on the host's 127.0.0.1 is out of reach).
 * Without that address: loopback on the host network, `host.docker.internal`
 * otherwise (Docker Desktop, where it is the host's loopback).
 */
export function keychainControlUrl(
    supervisorNetworkMode: string | undefined,
    keychainIp?: string | null
): string {
    const host = keychainIp
        ? keychainIp
        : supervisorNetworkMode === 'host'
          ? LOOPBACK
          : 'host.docker.internal'
    return `ws://${host}:${KEYCHAIN_CONTROL_PORT}/control`
}

/** What the agents' launcher calls (`KJ_KEYCHAIN_ENDPOINT`). */
export const KEYCHAIN_AGENT_ENDPOINT = `http://host.docker.internal:${KEYCHAIN_AGENT_PORT}`
