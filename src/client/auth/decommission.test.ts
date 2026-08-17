import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDecommission, writeDecommission } from './decommission'

function tempConfigDir(): string {
    return mkdtempSync(join(tmpdir(), 'kj-decom-'))
}

describe('la marca de baja (#270)', () => {
    test('una máquina sana no tiene marca', () => {
        const dir = tempConfigDir()
        try {
            expect(readDecommission(dir)).toBeNull()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test('lo que se escribe se lee, y sobrevive al reinicio', () => {
        // El punto entero de que esto viva en DISCO: el contenedor corre con
        // `--restart unless-stopped`, así que salir del proceso no es una
        // forma de parar. Al arrancar de nuevo, esto es lo que lo frena.
        const dir = tempConfigDir()
        try {
            const ok = writeDecommission(dir, {
                at: '2026-08-17T00:00:00.000Z',
                reason: 'El servidor se borró desde el panel.',
                server_id: 42,
            })
            expect(ok).toBe(true)

            const back = readDecommission(dir)
            expect(back?.server_id).toBe(42)
            expect(back?.reason).toContain('se borró desde el panel')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test('una marca corrupta cuenta como marca, no como ausencia', () => {
        // Si el fichero está a medias, ALGUIEN lo escribió. La lectura segura
        // de "quizá te dieron de baja" es quedarse quieto, no volver a llamar
        // al control cada treinta segundos.
        const dir = tempConfigDir()
        try {
            writeFileSync(join(dir, 'decommissioned'), '{ esto no es json')
            const back = readDecommission(dir)
            expect(back).not.toBeNull()
            expect(back?.reason).toContain('ilegible')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test('si no se puede escribir, lo dice en vez de fingir', () => {
        // Volumen de sólo lectura o lleno. Perder la marca cuesta un reinicio
        // que vuelve a parar — no una máquina que resucita —, pero el que
        // llama tiene que poder decirlo en el log.
        const ok = writeDecommission(join(tmpdir(), 'kj-no-existe-esta-carpeta-xyz'), {
            at: '2026-08-17T00:00:00.000Z',
            reason: 'da igual',
        })
        expect(ok).toBe(false)
    })
})
