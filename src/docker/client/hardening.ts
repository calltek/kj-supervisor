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
