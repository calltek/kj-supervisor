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

describe('quedarse quieto de verdad', () => {
    test('una promesa pendiente NO sujeta el proceso: hace falta un handle', async () => {
        // Este es el test que faltaba y que habría cazado el fallo: la primera
        // versión de `idleForever` devolvía `new Promise(() => {})`, que se lee
        // como si bloqueara y no bloquea. Con el resto de handles ya cerrados
        // —que es justo lo que hace `decommission()` antes de llamarlo— el
        // runtime vacía el bucle y sale en menos de un milisegundo, con lo que
        // `--restart unless-stopped` lo reinicia: el bucle que este diseño
        // existe para evitar.
        const proc = Bun.spawn(
            [
                process.execPath,
                '-e',
                "process.on('exit', c => console.log('EXIT', c)); new Promise(() => {})",
            ],
            { stdout: 'pipe' }
        )
        const salida = await new Response(proc.stdout).text()
        expect(salida).toContain('EXIT 0') // sale solo: no sujeta nada

        // Con un timer ref'ado, en cambio, sigue vivo: se le acaba matando.
        const conTimer = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1 << 30)'], {
            stdout: 'pipe',
        })
        await Bun.sleep(150)
        const seguiaVivo = conTimer.exitCode === null
        conTimer.kill()
        expect(seguiaVivo).toBe(true)
    })
})
