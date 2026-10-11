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
 * The image LABEL by which an agent image asks to run each conversation as its
 * own Linux user (kj-agent-base#107). Only an image that declares it gets the
 * extra capabilities below — every other image is created exactly as before.
 */
export const ISOLATION_LABEL = 'so.kujira.isolation'
export const ISOLATION_VALUE = 'per-conversation-uid'

/**
 * What a container that isolates conversations by uid gets ON TOP of the
 * baseline. The launcher stays root (PID 1) and drops each conversation's
 * `claude` to its own uid; for that, and to keep the files tidy across uids,
 * root needs these back after `CapDrop: ALL` stripped them:
 *  - SETUID / SETGID — become the conversation's uid/gid;
 *  - CHOWN / FOWNER — own the conversation's files and key files to that uid;
 *  - DAC_OVERRIDE — the launcher reads/writes what it set up for each uid;
 *  - KILL — stop a conversation's processes when it is recycled.
 * `no-new-privileges` still stands: dropping TO a lower uid needs no setuid
 * bit, so it keeps a compromised turn from GAINING any privilege.
 */
export function perUserIsolationCaps(): string[] {
    return ['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'KILL']
}

/**
 * Drop the isolation caps from a capability list. Used when recreating a
 * container: the isolation caps must come ONLY from the DESTINATION image's
 * label, never ride along from the source container's CapAdd — otherwise a
 * move to an image that doesn't isolate would keep them (and perpetuate them
 * on every later recreate). The invariant holds by construction, not by what
 * the next image happens to be (SOKI, #63).
 */
export function withoutIsolationCaps(caps?: string[] | null): string[] {
    const iso = new Set(perUserIsolationCaps())
    return (caps ?? []).filter((c) => !iso.has(c))
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
    /** The image isolates conversations by uid (ISOLATION_LABEL): add its caps. */
    isolation?: boolean | null
}): AgentHardening {
    const capAdd = [...(extras?.CapAdd ?? []), ...(extras?.isolation ? perUserIsolationCaps() : [])]
    return {
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ...(capAdd.length ? { CapAdd: capAdd } : {}),
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
