/**
 * The security posture of an agent container, built in ONE place.
 *
 * There are two ways an agent container comes into being — a fresh spawn
 * (`runContainer`) and a recreate on a new image (`recreateContainerWithImage`)
 * — and each used to assemble the hardening by hand. They already diverged
 * once: the recreate silently dropped `CapDrop: ALL` and `no-new-privileges`,
 * so any agent that got an image update came back running with Docker's ~14
 * default capabilities. Nothing failed, nothing logged; the container was
 * simply less protected than the identical one next to it.
 *
 * The fix at the time was to copy the block across. This is the constructor the
 * review asked for instead: one definition, two callers, so the next option
 * added here reaches both paths whether or not anyone remembers there are two.
 */

/** The device a VPN client needs to open a tunnel (KJ-156). */
const TUN_DEVICE = {
    PathOnHost: '/dev/net/tun',
    PathInContainer: '/dev/net/tun',
    CgroupPermissions: 'rwm',
} as const

export type ContainerDevice = {
    PathOnHost: string
    PathInContainer: string
    CgroupPermissions: string
}

/** The slice of `HostConfig` this module owns. */
export type AgentHardening = {
    CapDrop: string[]
    SecurityOpt: string[]
    CapAdd?: string[]
    Devices?: ContainerDevice[]
}

/**
 * What an agent allowed to manage its own networking gets ON TOP of the
 * baseline: `NET_ADMIN` and `/dev/net/tun`, and nothing else — `CapDrop: ALL`
 * still strips every other capability, and `no-new-privileges` still stands.
 * "Privileged" here is about the network, not about `--privileged`.
 */
export function privilegedNetworkingExtras(): { CapAdd: string[]; Devices: ContainerDevice[] } {
    return { CapAdd: ['NET_ADMIN'], Devices: [{ ...TUN_DEVICE }] }
}

/**
 * The hardening every agent container carries, plus whatever extras this
 * particular agent is entitled to.
 *
 * `extras` differs by caller, and that asymmetry is deliberate:
 *  - a fresh spawn knows the INTENT (`network_privileged` from the control) and
 *    passes `privilegedNetworkingExtras()`;
 *  - a recreate knows only what the previous container HAD, and passes that
 *    through — the source container is the source of truth for an agent's
 *    networking, so a VPN agent keeps its tunnel across an image update instead
 *    of losing it without a word.
 *
 * Empty or absent lists are dropped rather than sent as `[]`, so the resulting
 * `HostConfig` matches what a hand-written one would look like.
 */
export function agentHardening(extras?: {
    CapAdd?: string[] | null
    Devices?: ContainerDevice[] | null
}): AgentHardening {
    return {
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ...(extras?.CapAdd?.length ? { CapAdd: [...extras.CapAdd] } : {}),
        ...(extras?.Devices?.length ? { Devices: extras.Devices.map((d) => ({ ...d })) } : {}),
    }
}

/** El socket del demonio de Docker: la máquina entera en un fichero. */
const DOCKER_SOCKET = '/var/run/docker.sock'

/**
 * Strip any mount that would hand an agent the Docker socket.
 *
 * A container that can reach that socket can start another one as root, mount
 * the host filesystem and read every other agent's home — it isn't a mount, it's
 * the machine. The supervisor needs it (that's its job); an agent never does
 * (kj-supervisor#12).
 *
 * This matters on the RECREATE path specifically: it copies the mounts from
 * whatever the previous container had, so one container touched by hand would
 * pass the socket on to its replacement, and that one to the next, forever. The
 * spawn path builds its mounts from scratch and never adds it — but the filter
 * runs on both, because "the source had it" is exactly how this class of thing
 * comes back.
 *
 * Nothing legitimate is lost: no agent mount points at that path.
 */
export function withoutDockerSocket<
    T extends {
        Binds?: string[] | null
        Mounts?: { Source?: string; Target?: string }[] | null
    },
>(host: T): { Binds?: string[]; Mounts?: T['Mounts'] } {
    const touchesSocket = (...paths: (string | undefined)[]): boolean =>
        paths.some((p) => !!p && p.includes(DOCKER_SOCKET))
    return {
        ...(host.Binds ? { Binds: host.Binds.filter((b) => !touchesSocket(b)) } : {}),
        ...(host.Mounts
            ? {
                  Mounts: host.Mounts.filter(
                      (m) => !touchesSocket(m?.Source, m?.Target)
                  ) as T['Mounts'],
              }
            : {}),
    }
}
