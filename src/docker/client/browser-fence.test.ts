import { expect, test } from 'bun:test'

import { firstTarEntry, parseNameservers } from './browser-fence'

test('nameservers out of a resolv.conf', () => {
    expect(
        parseNameservers('# x\nnameserver 127.0.0.11\nnameserver fe80::1%eth0\nnameserver nope\n')
    ).toEqual(['127.0.0.11', 'fe80::1'])
})

test('the file out of a one-file tar', () => {
    const body = Buffer.from('nameserver 1.1.1.1\n')
    const header = Buffer.alloc(512)
    header.write('resolv.conf', 0)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    const tar = Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)])
    expect(firstTarEntry(tar).toString()).toBe(body.toString())
})
