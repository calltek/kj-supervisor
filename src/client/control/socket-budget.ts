/**
 * Que nada de lo que mande el supervisor pase del tope del socket.
 *
 * El control acepta mensajes de hasta 1 MB (`maxHttpBufferSize`). Uno más
 * grande no se rechaza: engine.io CIERRA la conexión entera
 * («Max payload size exceeded»). Un agente que lee un PDF o una imagen con
 * `Read` recibe su contenido en base64 dentro del `tool_result`, y ese evento
 * viajaba tal cual como `agent:output`: riva se reconectaba decenas de veces
 * al día, y cada corte se llevaba los acks en vuelo (las copias de seguridad,
 * entre ellos) y el propio evento (oct. 2026).
 *
 * Así que antes de emitir se mide, y lo que no cabe se recorta conservando la
 * forma: los bloques en base64 se cambian por una línea que dice qué había, y
 * las cadenas enormes se cortan. El `tool_use_id` y el resto de campos siguen
 * donde estaban, así que el control empareja el resultado con su llamada. Si
 * ni así cabe, no se manda: perder un evento es mejor que perder la conexión.
 */

/** Por debajo del MB del control, con margen para el envoltorio de socket.io. */
export const SOCKET_PAYLOAD_BUDGET = 900_000

/** Topes de cadena que se prueban, del más generoso al más agresivo. */
const STRING_CAPS = [64_000, 8_000, 1_000]

export function payloadBytes(event: string, payload: unknown): number {
    return Buffer.byteLength(JSON.stringify([event, payload]) ?? '', 'utf8')
}

/**
 * `payload` tal cual si cabe; si no, recortado hasta que quepa; `null` si no
 * hay forma. `shrunk` dice si se tocó algo.
 */
export function fitToSocket(
    event: string,
    payload: unknown,
    budget = SOCKET_PAYLOAD_BUDGET
): { payload: unknown; shrunk: boolean } | null {
    if (payloadBytes(event, payload) <= budget) return { payload, shrunk: false }
    for (const cap of STRING_CAPS) {
        const shrunk = shrink(payload, cap)
        if (payloadBytes(event, shrunk) <= budget) return { payload: shrunk, shrunk: true }
    }
    return null
}

function shrink(value: unknown, cap: number): unknown {
    if (typeof value === 'string') {
        if (value.length <= cap) return value
        const head = value.slice(0, cap)
        return `${head}… [recortado por Kujira: ${kb(value.length)} no caben en el socket]`
    }
    if (Array.isArray(value)) return value.map((v) => shrink(v, cap))
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        const inline = inlineFile(obj)
        if (inline) return inline
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(obj)) out[k] = shrink(v, cap)
        return out
    }
    return value
}

/**
 * Un bloque de imagen o documento en base64 (`{type, source: {type: 'base64',
 * data}}`) pasa a ser una línea de texto: medio base64 no le sirve a nadie, y
 * un bloque de imagen con los datos cortados rompería a quien lo pinte.
 */
function inlineFile(obj: Record<string, unknown>): Record<string, unknown> | null {
    if (obj.type !== 'image' && obj.type !== 'document') return null
    const source = obj.source as Record<string, unknown> | undefined
    if (!source || source.type !== 'base64' || typeof source.data !== 'string') return null
    const what = obj.type === 'image' ? 'imagen omitida' : 'documento omitido'
    return {
        type: 'text',
        text: `[${what} por Kujira: ${kb(source.data.length)} no caben en el socket]`,
    }
}

function kb(chars: number): string {
    return `${Math.round(chars / 1024)} KB`
}
