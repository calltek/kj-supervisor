import { describe, expect, test } from 'bun:test'

import { McpDispatcher, isMcpEnvelope, type McpEnvelope } from './mcp-dispatcher'
import type { McpRequestAck } from '../protocol'

function silentLogger() {
    const noop = () => {}
    const fakeLogger = {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        fatal: noop,
        trace: noop,
        child: () => fakeLogger,
    }
    return fakeLogger as unknown as Parameters<typeof McpDispatcher>[0]['logger']
}

describe('isMcpEnvelope', () => {
    test('returns true on lines with the marker', () => {
        expect(
            isMcpEnvelope({
                kj_channel: 'mcp',
                kind: 'request',
                request_id: 'r1',
                tool: 'memory_list',
                args: {},
            })
        ).toBe(true)
    })

    test('returns false on raw stream-json events', () => {
        expect(isMcpEnvelope({ type: 'assistant', message: { content: [] } })).toBe(false)
        expect(isMcpEnvelope({ kj_channel: 'claude' })).toBe(false)
        expect(isMcpEnvelope({ kj_channel: 'mcp' })).toBe(false) // no kind
    })
})

describe('McpDispatcher.onContainerLine', () => {
    test('forwards a request to the control and writes the success ack back to the container', async () => {
        const writes: McpEnvelope[] = []
        const sentRequests: Array<{
            agent_id: number
            request_id: string
            tool: string
            args: Record<string, unknown>
        }> = []
        const dispatcher = new McpDispatcher({
            sendRequest: async (agent_id, request_id, tool, args) => {
                sentRequests.push({ agent_id, request_id, tool, args })
                return {
                    ok: true,
                    data: { items: [{ id: 1, name: 'guia.md' }] },
                } satisfies McpRequestAck
            },
            writeToContainer: (_agent_id, envelope) => {
                writes.push(envelope)
                return true
            },
            logger: silentLogger(),
        })

        dispatcher.onContainerLine(42, {
            kj_channel: 'mcp',
            kind: 'request',
            request_id: 'r1',
            tool: 'memory_list',
            args: {},
        })

        // sendRequest is async — let microtasks flush.
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))

        expect(sentRequests).toEqual([
            { agent_id: 42, request_id: 'r1', tool: 'memory_list', args: {} },
        ])
        expect(writes).toEqual([
            {
                kj_channel: 'mcp',
                kind: 'response',
                request_id: 'r1',
                ok: true,
                data: { items: [{ id: 1, name: 'guia.md' }] },
            },
        ])
    })

    test('forwards a structured error ack back to the container', async () => {
        const writes: McpEnvelope[] = []
        const dispatcher = new McpDispatcher({
            sendRequest: async () =>
                ({
                    ok: false,
                    error: {
                        code: 'MEMORY_NOT_FOUND',
                        message: 'No memory named "x.md" assigned',
                        retryable: false,
                    },
                }) satisfies McpRequestAck,
            writeToContainer: (_agent_id, envelope) => {
                writes.push(envelope)
                return true
            },
            logger: silentLogger(),
        })

        dispatcher.onContainerLine(42, {
            kj_channel: 'mcp',
            kind: 'request',
            request_id: 'r2',
            tool: 'memory_read',
            args: { name: 'x.md' },
        })
        await new Promise((r) => setImmediate(r))

        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({
            kind: 'response',
            request_id: 'r2',
            ok: false,
            error: { code: 'MEMORY_NOT_FOUND' },
        })
    })

    test('on transport failure, writes a SUPERVISOR_TIMEOUT error response', async () => {
        const writes: McpEnvelope[] = []
        const dispatcher = new McpDispatcher({
            sendRequest: () => Promise.reject(new Error('ack timeout for mcp:request after 15000ms')),
            writeToContainer: (_agent_id, envelope) => {
                writes.push(envelope)
                return true
            },
            logger: silentLogger(),
        })

        dispatcher.onContainerLine(42, {
            kj_channel: 'mcp',
            kind: 'request',
            request_id: 'r3',
            tool: 'memory_list',
            args: {},
        })
        await new Promise((r) => setImmediate(r))

        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({
            kind: 'response',
            request_id: 'r3',
            ok: false,
            error: { code: 'SUPERVISOR_TIMEOUT', retryable: true },
        })
    })

    test('drops responses/pushes that come from the container side', () => {
        const writes: McpEnvelope[] = []
        const dispatcher = new McpDispatcher({
            sendRequest: async () => ({ ok: true, data: {} }) satisfies McpRequestAck,
            writeToContainer: (_agent_id, envelope) => {
                writes.push(envelope)
                return true
            },
            logger: silentLogger(),
        })

        dispatcher.onContainerLine(42, {
            kj_channel: 'mcp',
            kind: 'response',
            request_id: 'r4',
            ok: true,
            data: {},
        })

        expect(writes).toHaveLength(0)
    })
})

describe('McpDispatcher.forwardPushToContainer', () => {
    test('writes a push envelope with topic+payload', () => {
        const writes: McpEnvelope[] = []
        const dispatcher = new McpDispatcher({
            sendRequest: async () => ({ ok: true, data: {} }) satisfies McpRequestAck,
            writeToContainer: (_agent_id, envelope) => {
                writes.push(envelope)
                return true
            },
            logger: silentLogger(),
        })

        dispatcher.forwardPushToContainer(42, 'memory:updated', {
            memory_id: 7,
            name: 'guia.md',
            scope: 'SHORT_TERM',
            action: 'updated',
        })

        expect(writes).toEqual([
            {
                kj_channel: 'mcp',
                kind: 'push',
                topic: 'memory:updated',
                payload: {
                    memory_id: 7,
                    name: 'guia.md',
                    scope: 'SHORT_TERM',
                    action: 'updated',
                },
            },
        ])
    })

    test('drops the push silently when the container isn\'t streaming locally', () => {
        const dispatcher = new McpDispatcher({
            sendRequest: async () => ({ ok: true, data: {} }) satisfies McpRequestAck,
            writeToContainer: () => false,
            logger: silentLogger(),
        })
        // Just checks it doesn't throw.
        dispatcher.forwardPushToContainer(99, 'memory:updated', {
            memory_id: 1,
            name: 'x.md',
            scope: 'SHORT_TERM',
            action: 'deleted',
        })
    })
})
