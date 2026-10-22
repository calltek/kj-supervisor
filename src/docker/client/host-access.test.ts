import { describe, expect, test } from 'bun:test'
import {
    HOST_ALIAS,
    agentHostAliases,
    isHostGatewayUnsupported,
    recreatedHostAliases,
} from './host-access'

describe('el alias del host', () => {
    test('un contenedor nuevo puede nombrar a su máquina', () => {
        // En Linux `host.docker.internal` NO existe salvo que se pida así. Sin
        // esta línea, la misma configuración que funciona en un portátil falla
        // en un VPS con un DNS que no resuelve — y eso se lee como «el modelo
        // no contesta», no como un fallo de red.
        expect(agentHostAliases()).toEqual([`${HOST_ALIAS}:host-gateway`])
    })
})

describe('al recrear un contenedor', () => {
    const ALIAS = [`${HOST_ALIAS}:host-gateway`]

    test('se añade el alias si no lo tenía', () => {
        for (const origen of [undefined, null, []])
            expect(recreatedHostAliases(origen)).toEqual({ hosts: ALIAS, dropped: [] })
    })

    test('no se duplica si ya estaba', () => {
        // Recrear un contenedor ya recreado no puede ir acumulando entradas:
        // un `ExtraHosts` con el mismo nombre dos veces es ambiguo.
        const once = recreatedHostAliases([]).hosts
        expect(recreatedHostAliases(once)).toEqual({ hosts: ALIAS, dropped: [] })
    })

    test('el alias se reconoce sin mirar mayúsculas', () => {
        const origen = ['HOST.Docker.Internal:host-gateway']
        expect(recreatedHostAliases(origen)).toEqual({ hosts: ALIAS, dropped: [] })
    })

    test('una entrada ajena NO sobrevive, y se devuelve para dejar traza (#34)', () => {
        // Un `/etc/hosts` reescrito a mano que pasara de recreación en
        // recreación es un MITM persistente contra un agente con credenciales.
        const origen = ['api.github.com:10.6.6.6', `${HOST_ALIAS}:host-gateway`]
        expect(recreatedHostAliases(origen)).toEqual({
            hosts: ALIAS,
            dropped: ['api.github.com:10.6.6.6'],
        })
    })

    test('tampoco un alias del host desviado a otra IP', () => {
        // Es el nombre por el que el agente llega a su modelo: desviarlo es el
        // mismo ataque.
        expect(recreatedHostAliases([`${HOST_ALIAS}:10.0.0.5`])).toEqual({
            hosts: ALIAS,
            dropped: [`${HOST_ALIAS}:10.0.0.5`],
        })
    })
})

describe('un demonio que no admite host-gateway', () => {
    test('se reconoce por el mensaje de Docker', () => {
        // Engine < 20.10, y uno moderno sin IP de pasarela que derivar.
        expect(
            isHostGatewayUnsupported(
                new Error('(HTTP code 400) invalid IP address in add-host: "host-gateway"')
            )
        ).toBe(true)
        expect(
            isHostGatewayUnsupported(new Error('unable to derive the IP value for host-gateway'))
        ).toBe(true)
    })

    test('cualquier otro fallo no se confunde con éste', () => {
        expect(isHostGatewayUnsupported(new Error('No such image: img:new'))).toBe(false)
        expect(isHostGatewayUnsupported(new Error('Conflict. The container name is in use'))).toBe(
            false
        )
    })
})
