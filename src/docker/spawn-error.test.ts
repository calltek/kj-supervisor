import { describe, expect, test } from 'bun:test'
import { describeDockerRunFailure } from './spawn-error'

describe('describeDockerRunFailure', () => {
    test('explains the /dev/net/tun failure and how to fix it', () => {
        // The exact shape Docker returns on a host without the tun device — a
        // Synology NAS with privileged networking (VPN) turned on.
        const err = new Error(
            '(HTTP code 500) server error - error gathering device information ' +
                'while adding custom device "/dev/net/tun": no such file or directory'
        )
        const msg = describeDockerRunFailure(err, 'docker run failed')

        expect(msg).toContain('red privilegiada')
        expect(msg).toContain('/dev/net/tun')
        // Names the remedy, not just the symptom.
        expect(msg.toLowerCase()).toContain('desactiva')
        // Keeps the raw Docker text for the log / the curious.
        expect(msg).toContain('no such file or directory')
    })

    test('a mismatched /dev/net/tun error is not force-fit', () => {
        // Same device path, different failure — must NOT claim it's the VPN.
        const err = new Error('permission denied opening /dev/net/tun')
        expect(describeDockerRunFailure(err, 'docker run failed')).toBe(
            'docker run failed: permission denied opening /dev/net/tun'
        )
    })

    test('any other error falls back to the given prefix', () => {
        expect(describeDockerRunFailure(new Error('image not found'), 'recreate failed')).toBe(
            'recreate failed: image not found'
        )
        expect(describeDockerRunFailure('boom', 'docker run failed')).toBe(
            'docker run failed: boom'
        )
    })
})
