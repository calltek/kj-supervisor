/**
 * Dónde guarda el agente una sesión dentro de su volumen (`/home/agent`), en
 * rutas RELATIVAS a la raíz del volumen. Es la misma cuenta que hace el
 * envoltorio de kj-agent-base (`sessionCwd` y `transcriptDir`): si cambia allí,
 * cambia aquí.
 *
 *  - `conv/<sid>`: la carpeta de trabajo de la sesión.
 *  - `.claude/projects/<cwd codificado>`: el transcript `<sid>.jsonl`, la
 *    auto-memoria y los transcripts de los subagentes. El CLI codifica el cwd
 *    cambiando todo lo que no sea letra o número por `-`.
 *  - Lo que el CLI guarda aparte con el id de la sesión: sus tareas, su
 *    historial de ficheros y su entorno.
 */

/** El mismo filtro que aplica el envoltorio antes de tocar una ruta. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

const AGENT_HOME = '/home/agent'

export function isValidSessionId(id: unknown): id is string {
    return typeof id === 'string' && SESSION_ID_RE.test(id)
}

export function sessionPaths(session_id: string): string[] {
    if (!isValidSessionId(session_id)) throw new Error('invalid session id')
    const cwd = `${AGENT_HOME}/conv/${session_id}`
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    return [
        `conv/${session_id}`,
        `.claude/projects/${encoded}`,
        `.claude/file-history/${session_id}`,
        `.claude/session-env/${session_id}`,
    ]
}

/**
 * El guion de shell que borra esas rutas dentro del ayudante (volumen montado
 * en `/v`). Los ids ya han pasado `SESSION_ID_RE`, así que van tal cual: sólo
 * letras, números, `_` y `-`. Las tareas del CLI se llaman `<sid>-agent-…`,
 * de ahí el comodín sólo en esa carpeta. `rm -rf` de algo que no existe no
 * falla: repetir el borrado es inofensivo.
 */
export function purgeScript(session_ids: string[]): string {
    const lines = ['set -e']
    for (const sid of session_ids) {
        for (const p of sessionPaths(sid)) lines.push(`rm -rf -- "/v/${p}"`)
        lines.push(`rm -f -- /v/.claude/todos/${sid}-*`)
    }
    return lines.join('\n')
}
