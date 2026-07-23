/**
 * Human-readable rendering of a docker-run failure for `agent:status.last_action`.
 *
 * Raw Docker errors otherwise surface verbatim, so a common misconfiguration
 * reads as a stack-trace fragment. Shared by the spawn and image-update paths,
 * which both start a container and can hit the same host limitations.
 */

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/**
 * Lead with the cause + fix for the failures an operator can actually resolve,
 * keeping the original Docker text appended for the log / the curious.
 *
 * The one that keeps biting: privileged networking (VPN, KJ-156) turned on for
 * a host whose kernel has no `/dev/net/tun` — a Synology NAS, most notably.
 * Docker fails with "error gathering device information while adding custom
 * device /dev/net/tun: no such file or directory", which names neither the VPN
 * toggle nor the remedy.
 *
 * `prefix` is what a non-matched error falls back to ("docker run failed",
 * "recreate failed"…), so each call site keeps its own wording.
 */
export function describeDockerRunFailure(err: unknown, prefix: string): string {
    const raw = errMessage(err)
    if (/\/dev\/net\/tun/.test(raw) && /no such file or directory/i.test(raw)) {
        return (
            'Este servidor no soporta red privilegiada (VPN): su kernel no tiene ' +
            '/dev/net/tun (típico en un NAS Synology). Desactiva "red privilegiada" ' +
            `en la configuración del agente para arrancar aquí. [docker: ${raw}]`
        )
    }
    return `${prefix}: ${raw}`
}
