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
