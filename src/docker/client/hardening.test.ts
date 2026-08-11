import { describe, expect, test } from 'bun:test'
import { agentHardening, privilegedNetworkingExtras } from './hardening'

/**
 * El fallo que originó todo esto no fue un error de lógica: fue que el mismo
 * blindaje estaba escrito dos veces —al crear un contenedor y al recrearlo— y
 * una copia se quedó atrás. Un agente actualizado volvía con las ~14
 * capacidades por defecto de Docker y sin `no-new-privileges`, sin que nada
 * fallara ni se registrara.
 *
 * Estas pruebas fijan lo que hace el constructor único, y sobre todo que los
 * dos caminos producen lo MISMO (#13).
 */
describe('agentHardening', () => {
    test('la base: sin capacidades y sin escalar privilegios', () => {
        expect(agentHardening()).toEqual({
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
        })
    })

    test('un agente normal no lleva dispositivos ni capacidades extra', () => {
        // Ausentes, no vacíos: `CapAdd: []` viajaría al daemon y ensuciaría la
        // comparación con la config que escribiría una persona a mano.
        const h = agentHardening({ CapAdd: [], Devices: [] })

        expect('CapAdd' in h).toBe(false)
        expect('Devices' in h).toBe(false)
    })

    test('el agente con VPN suma NET_ADMIN y /dev/net/tun, y nada más', () => {
        const h = agentHardening(privilegedNetworkingExtras())

        expect(h.CapAdd).toEqual(['NET_ADMIN'])
        expect(h.Devices?.[0]?.PathInContainer).toBe('/dev/net/tun')
        // Lo que de verdad importa del "privilegiado": sigue sin ser privilegiado.
        expect(h.CapDrop).toEqual(['ALL'])
        expect(h.SecurityOpt).toEqual(['no-new-privileges'])
    })

    test('crear y recrear producen exactamente el mismo blindaje', () => {
        // El recreate no conoce la intención del control: sólo ve lo que tenía
        // el contenedor de origen. Si ambos caminos no coinciden, un agente
        // pierde protección (o su túnel) al actualizar la imagen sin avisar.
        const alCrear = agentHardening(privilegedNetworkingExtras())
        const alRecrear = agentHardening({ CapAdd: alCrear.CapAdd, Devices: alCrear.Devices })

        expect(alRecrear).toEqual(alCrear)

        const normalAlCrear = agentHardening(undefined)
        const normalAlRecrear = agentHardening({
            CapAdd: normalAlCrear.CapAdd,
            Devices: normalAlCrear.Devices,
        })
        expect(normalAlRecrear).toEqual(normalAlCrear)
    })

    test('no devuelve las listas que le pasan: nadie puede mutarlas por detrás', () => {
        const extras = privilegedNetworkingExtras()
        const h = agentHardening(extras)

        extras.CapAdd.push('SYS_ADMIN')
        const [device] = extras.Devices
        if (device) device.PathOnHost = '/dev/mem'

        expect(h.CapAdd).toEqual(['NET_ADMIN'])
        expect(h.Devices?.[0]?.PathOnHost).toBe('/dev/net/tun')
    })

    test('null se trata como ausente (dockerode los devuelve así)', () => {
        const h = agentHardening({ CapAdd: null, Devices: null })

        expect(h).toEqual({ CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] })
    })
})
