import { describe, expect, test } from 'bun:test'
import type { KJDocker } from '../../docker/client/client'
import type { KJLogger } from '../../logger'
import type { AgentStatusReporter } from '../../reporters/agent-status/agent-status.reporter'
import { AgentBackupHandler } from './agent-backup.handler'

const fakeLogger = {
    child: () => fakeLogger,
    info: () => {},
    error: () => {},
    warn: () => {},
} as unknown as KJLogger

function makeHandler(docker: Partial<KJDocker>) {
    const pushes: Array<Record<string, unknown>> = []
    const status = {
        push: (s: Record<string, unknown>) => pushes.push(s),
    } as unknown as AgentStatusReporter
    const handler = new AgentBackupHandler({
        docker: docker as KJDocker,
        status,
        logger: fakeLogger,
    })
    return { handler, pushes }
}

describe('AgentBackupHandler', () => {
    test('backup tars the agent volume to the upload URL and returns the size', async () => {
        const calls: Array<{ volume: string; url: string }> = []
        const { handler } = makeHandler({
            backupVolume: async (volume: string, url: string) => {
                calls.push({ volume, url })
                return { size_bytes: 4096 }
            },
        })
        const ack = await handler.handleBackup({
            request_id: 'r1',
            agent_id: 42,
            upload_url: 'https://r2/put',
        })
        expect(ack.ok).toBe(true)
        expect(ack.size_bytes).toBe(4096)
        // Volume name is derived from the agent id, same as spawn.
        expect(calls[0]).toEqual({ volume: 'kj-agent-42-home', url: 'https://r2/put' })
    })

    test('multipart: the parts reach the control, which needs them to seal the object', async () => {
        // A tarball over R2's single-PUT ceiling goes up in pieces (#263).
        // The ETags are the whole point of the ack: without them the bytes
        // sit in R2 as loose parts and never become an object.
        let seen: unknown
        const { handler } = makeHandler({
            backupVolume: async (_volume: string, _url: string, multipart?: unknown) => {
                seen = multipart
                return {
                    size_bytes: 6_666_226_321,
                    parts: [
                        { part_number: 1, etag: '"aaa"' },
                        { part_number: 2, etag: '"bbb"' },
                    ],
                }
            },
        })
        const multipart = {
            upload_id: 'up-1',
            part_urls: ['https://r2/part1', 'https://r2/part2'],
            part_size_bytes: 536_870_912,
            single_put_limit_bytes: 5_364_514_816,
        }
        const ack = await handler.handleBackup({
            request_id: 'r1',
            agent_id: 42,
            upload_url: 'https://r2/put',
            multipart,
        })
        expect(ack.ok).toBe(true)
        expect(ack.size_bytes).toBe(6_666_226_321)
        expect(ack.parts).toEqual([
            { part_number: 1, etag: '"aaa"' },
            { part_number: 2, etag: '"bbb"' },
        ])
        // The handler forwards the signed URLs untouched.
        expect(seen).toEqual(multipart)
    })

    test('a single-PUT backup carries no parts in the ack', async () => {
        const { handler } = makeHandler({
            backupVolume: async () => ({ size_bytes: 4096 }),
        })
        const ack = await handler.handleBackup({
            request_id: 'r1',
            agent_id: 42,
            upload_url: 'https://r2/put',
            multipart: {
                upload_id: 'up-1',
                part_urls: ['https://r2/part1'],
                part_size_bytes: 536_870_912,
                single_put_limit_bytes: 5_364_514_816,
            },
        })
        expect(ack.ok).toBe(true)
        // No `parts` key at all — the control reads its absence as "the
        // single PUT did it", and abandons the multipart it had opened.
        expect('parts' in ack).toBe(false)
    })

    test('backup failure → ok:false with an error', async () => {
        const { handler } = makeHandler({
            backupVolume: async () => {
                throw new Error('tar exploded')
            },
        })
        const ack = await handler.handleBackup({
            request_id: 'r1',
            agent_id: 42,
            upload_url: 'https://r2/put',
        })
        expect(ack.ok).toBe(false)
        expect(ack.error?.message).toContain('tar exploded')
    })

    test('restore stops+removes the live container, extracts, leaves STOPPED', async () => {
        const stopped: string[] = []
        const removed: string[] = []
        const restored: Array<{ volume: string; url: string }> = []
        const { handler, pushes } = makeHandler({
            listKjContainers: async () => [{ container_id: 'c-old', agent_id: 42 }],
            stopContainer: async (id: string) => {
                stopped.push(id)
            },
            removeContainer: async (id: string) => {
                removed.push(id)
            },
            restoreVolume: async (volume: string, url: string) => {
                restored.push({ volume, url })
            },
        })
        const ack = await handler.handleRestore({
            request_id: 'r1',
            agent_id: 42,
            download_url: 'https://r2/get',
            restart_after: true,
        })
        expect(ack.ok).toBe(true)
        expect(stopped).toEqual(['c-old'])
        expect(removed).toEqual(['c-old'])
        expect(restored[0]).toEqual({ volume: 'kj-agent-42-home', url: 'https://r2/get' })
        // Left STOPPED for the operator to start back.
        expect(pushes[0]?.status).toBe('STOPPED')
    })

    test('restore with no live container just extracts onto the volume', async () => {
        const restored: string[] = []
        const { handler } = makeHandler({
            listKjContainers: async () => [],
            restoreVolume: async (volume: string) => {
                restored.push(volume)
            },
        })
        const ack = await handler.handleRestore({
            request_id: 'r1',
            agent_id: 7,
            download_url: 'https://r2/get',
            restart_after: false,
        })
        expect(ack.ok).toBe(true)
        expect(restored).toEqual(['kj-agent-7-home'])
    })
})
