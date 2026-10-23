import { describe, expect, test } from 'bun:test'
import { SOCKET_PAYLOAD_BUDGET, fitToSocket, payloadBytes } from './socket-budget'

// El `tool_result` de un `Read` sobre un PDF: el caso que cerraba el socket
// de riva («Max payload size exceeded», oct. 2026).
function readOfPdf(bytes: number) {
    return {
        agent_id: 10,
        seq: 7,
        event: {
            type: 'user',
            message: {
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_123',
                        content: [
                            {
                                type: 'document',
                                source: {
                                    type: 'base64',
                                    media_type: 'application/pdf',
                                    data: 'A'.repeat(bytes),
                                },
                            },
                        ],
                    },
                ],
            },
        },
    }
}

describe('fitToSocket', () => {
    test('lo que cabe sale tal cual', () => {
        const payload = readOfPdf(10_000)
        const fit = fitToSocket('agent:output', payload)
        expect(fit?.shrunk).toBe(false)
        expect(fit?.payload).toBe(payload)
    })

    test('un documento en base64 que no cabe se cambia por una línea, y el resto se queda', () => {
        const fit = fitToSocket('agent:output', readOfPdf(3_000_000))
        expect(fit?.shrunk).toBe(true)
        expect(payloadBytes('agent:output', fit?.payload)).toBeLessThanOrEqual(
            SOCKET_PAYLOAD_BUDGET
        )
        const result = (fit?.payload as ReturnType<typeof readOfPdf>).event.message.content[0]
        // El control empareja el resultado con su llamada por este id.
        expect(result?.tool_use_id).toBe('toolu_123')
        const block = result?.content[0] as unknown as { type: string; text: string }
        expect(block.type).toBe('text')
        expect(block.text).toContain('documento omitido')
    })

    test('una cadena enorme se corta en vez de cerrar la conexión', () => {
        const fit = fitToSocket('agent:output', { event: { result: 'x'.repeat(2_000_000) } })
        expect(fit?.shrunk).toBe(true)
        expect(JSON.stringify(fit?.payload)).toContain('recortado por Kujira')
        expect(payloadBytes('agent:output', fit?.payload)).toBeLessThanOrEqual(
            SOCKET_PAYLOAD_BUDGET
        )
    })

    test('si ni recortado cabe, no se manda', () => {
        // Muchas cadenas pequeñas: no hay nada largo que cortar.
        const many = Array.from({ length: 200_000 }, (_, i) => `item-${i}`)
        expect(fitToSocket('agent:output', { many })).toBeNull()
    })
})
