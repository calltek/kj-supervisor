/**
 * Limpieza de imágenes huérfanas.
 *
 * Cada despliegue deja atrás la imagen anterior de kj-agent-flex o
 * kj-supervisor, sin etiqueta y a 2,6 GB la del agente: sin esto, el disco de
 * la máquina se llena solo. Una imagen que aún usa un contenedor no se toca, y
 * esa misma imagen cae en la pasada siguiente, cuando ya nadie la usa.
 */

import type { OrphanImagesResult } from '../client/client'

/** Lo bastante tarde para que el supervisor anterior ya no esté tras un upgrade. */
export const FIRST_CLEANUP_DELAY_MS = 10 * 60_000
export const CLEANUP_INTERVAL_MS = 6 * 60 * 60_000

export interface ImageCleanupHandle {
    stop(): void
}

export interface ImageCleanupOptions {
    docker: { removeOrphanImages(): Promise<OrphanImagesResult> }
    logger: {
        info: (obj: object, msg?: string) => void
        warn: (obj: object, msg?: string) => void
    }
    /** Inyectables para probar sin reloj. */
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
}

export function startImageCleanupLoop(opts: ImageCleanupOptions): ImageCleanupHandle {
    const { docker, logger } = opts
    const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

    let stopped = false
    let timer: unknown = null

    const schedule = (ms: number): void => {
        if (stopped) return
        timer = setTimer(() => void run(), ms)
    }

    const run = async (): Promise<void> => {
        try {
            const { removed, failed } = await docker.removeOrphanImages()
            if (removed > 0 || failed > 0) {
                logger.info({ removed, failed }, 'imágenes huérfanas borradas')
            }
        } catch (err) {
            // Docker caído o sin responder: se reintenta en la siguiente pasada.
            logger.warn({ err }, 'no pude limpiar las imágenes huérfanas')
        }
        schedule(CLEANUP_INTERVAL_MS)
    }

    schedule(FIRST_CLEANUP_DELAY_MS)

    return {
        stop(): void {
            stopped = true
            if (timer !== null) clearTimer(timer)
            timer = null
        },
    }
}
