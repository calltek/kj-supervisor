/**
 * Bucle de «¿debo actualizarme?».
 *
 * El supervisor pregunta por su cuenta al control (`server:update:check`), sin
 * horario fijo: una vez tras cada handshake (con un retraso aleatorio para no
 * pisar el hello ni a toda la flota a la vez) y después cuando el ack le diga.
 * Si el control contesta `update`, ya le ha mandado (o le mandará en segundos)
 * el comando de upgrade de siempre; aquí no se hace nada más, sólo se deja de
 * preguntar.
 */

// TODO: sale de protocol.ts cuando el backend lo despliegue
export interface ServerUpdateCheckPayload {
    revision: string | null
}

// TODO: sale de protocol.ts cuando el backend lo despliegue
export interface ServerUpdateCheckAck {
    action: 'update' | 'wait' | 'none'
    retry_after_ms: number
}

export const UPDATE_CHECK_EVENT = 'server:update:check'
export const FIRST_CHECK_MAX_DELAY_MS = 5 * 60_000
export const MIN_RETRY_MS = 60_000
export const MAX_RETRY_MS = 24 * 60 * 60_000
export const FAILED_RETRY_MS = 6 * 60 * 60_000
export const ACK_TIMEOUT_MS = 10_000

export interface UpdateCheckHandle {
    stop(): void
}

export interface UpdateCheckOptions {
    /** settings.image_revision; sin ella (build local) no se pregunta nunca. */
    revision: string | null | undefined
    emitWithAck: <T>(event: string, payload: unknown, timeoutMs: number) => Promise<T>
    logger: {
        debug: (obj: object, msg?: string) => void
        info: (obj: object, msg?: string) => void
    }
    /** Inyectables para probar sin red ni reloj. */
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
    random?: () => number
}

const clamp = (ms: number): number => Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ms))

export function startUpdateCheckLoop(opts: UpdateCheckOptions): UpdateCheckHandle {
    const { revision, emitWithAck, logger } = opts
    const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    const random = opts.random ?? Math.random

    if (!revision) {
        logger.debug({}, 'sin image_revision (build local): no se pregunta por actualizaciones')
        return { stop() {} }
    }

    let stopped = false
    let timer: unknown = null

    const schedule = (ms: number): void => {
        if (stopped) return
        timer = setTimer(() => void check(), ms)
    }

    const check = async (): Promise<void> => {
        timer = null
        if (stopped) return
        let ack: ServerUpdateCheckAck
        try {
            ack = await emitWithAck<ServerUpdateCheckAck>(
                UPDATE_CHECK_EVENT,
                { revision } satisfies ServerUpdateCheckPayload,
                ACK_TIMEOUT_MS
            )
        } catch (err) {
            // Backend viejo sin el evento (o red caída): sin ruido.
            logger.debug(
                { error: err instanceof Error ? err.message : String(err) },
                'update check sin respuesta; reintento en 6 h'
            )
            schedule(FAILED_RETRY_MS)
            return
        }
        if (stopped) return
        if (ack?.action === 'update') {
            logger.info({}, 'el control ordena actualizar; dejo de preguntar')
            return
        }
        const retry = typeof ack?.retry_after_ms === 'number' ? ack.retry_after_ms : FAILED_RETRY_MS
        const next = clamp(Number.isFinite(retry) ? retry : FAILED_RETRY_MS)
        logger.debug({ action: ack?.action, next_ms: next }, 'update check hecho')
        schedule(next)
    }

    schedule(Math.floor(random() * FIRST_CHECK_MAX_DELAY_MS))

    return {
        stop() {
            stopped = true
            if (timer !== null) clearTimer(timer)
            timer = null
        },
    }
}
