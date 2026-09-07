import { describe, expect, test } from 'bun:test'
import { HOST_ALIAS, agentHostAliases, withHostAlias } from './host-access'

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
    test('se añade el alias si no lo tenía', () => {
        expect(withHostAlias(undefined)).toEqual([`${HOST_ALIAS}:host-gateway`])
        expect(withHostAlias(null)).toEqual([`${HOST_ALIAS}:host-gateway`])
        expect(withHostAlias([])).toEqual([`${HOST_ALIAS}:host-gateway`])
    })

    test('no se duplica si ya estaba', () => {
        // Recrear un contenedor ya recreado no puede ir acumulando entradas:
        // un `ExtraHosts` con el mismo nombre dos veces es ambiguo.
        const once = withHostAlias([])
        expect(withHostAlias(once)).toEqual(once)
    })

    test('se respeta un alias que apunte a otro sitio', () => {
        // Si alguien lo fijó a mano a una IP concreta, ésa es su intención:
        // el mismo criterio con el que la recreación hereda CapAdd y Devices
        // del contenedor de origen y no de lo que el control cree.
        const manual = [`${HOST_ALIAS}:10.0.0.5`]
        expect(withHostAlias(manual)).toEqual(manual)
    })

    test('no se pierde lo que el agente ya tuviera', () => {
        const otros = ['registro.interno:10.1.2.3', 'nas.local:10.1.2.9']
        expect(withHostAlias(otros)).toEqual([...otros, `${HOST_ALIAS}:host-gateway`])
    })
})
