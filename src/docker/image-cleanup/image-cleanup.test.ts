import { describe, expect, test } from 'bun:test'
import { CLEANUP_INTERVAL_MS, FIRST_CLEANUP_DELAY_MS, startImageCleanupLoop } from './image-cleanup'

const logger = { info: () => {}, warn: () => {} }

describe('startImageCleanupLoop', () => {
    test('un fallo de Docker no para el bucle', async () => {
        const delays: number[] = []
        let fire: () => void = () => {}
        let passes = 0
        startImageCleanupLoop({
            docker: {
                removeOrphanImages: async () => {
                    passes += 1
                    throw new Error('docker caído')
                },
            },
            logger,
            setTimer: (fn, ms) => {
                delays.push(ms)
                fire = fn
                return 0
            },
            clearTimer: () => {},
        })

        fire()
        await Bun.sleep(0)

        expect(passes).toBe(1)
        expect(delays).toEqual([FIRST_CLEANUP_DELAY_MS, CLEANUP_INTERVAL_MS])
    })

    test('stop corta también una pasada ya en marcha', async () => {
        const delays: number[] = []
        let fire: () => void = () => {}
        const handle = startImageCleanupLoop({
            docker: { removeOrphanImages: async () => ({ removed: 0, failed: 0 }) },
            logger,
            setTimer: (fn, ms) => {
                delays.push(ms)
                fire = fn
                return 0
            },
            clearTimer: () => {},
        })

        fire()
        handle.stop()
        await Bun.sleep(0)

        expect(delays).toEqual([FIRST_CLEANUP_DELAY_MS])
    })
})
