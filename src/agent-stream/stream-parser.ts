/**
 * Newline-delimited JSON parser for Claude Code's stream-json output.
 *
 * The container writes one JSON object per line on stdout. We read
 * raw bytes from the dockerode attach stream and split on `\n`,
 * tolerating partial chunks (a line may straddle two chunks) and
 * malformed lines (truncated on SIGKILL, garbage from an unrelated
 * process). Each parsed object is handed to `onEvent`; everything
 * else is logged via `onSkip` and dropped.
 */

import type { KJLogger } from '../logger'

export interface StreamParserOptions {
    onEvent: (event: Record<string, unknown>) => void
    onSkip?: (reason: 'invalid_json' | 'empty_line', line: string) => void
    logger?: KJLogger
}

export class NDJSONStreamParser {
    private buffer = ''
    private readonly onEvent: StreamParserOptions['onEvent']
    private readonly onSkip: StreamParserOptions['onSkip']
    private readonly logger?: KJLogger

    constructor(opts: StreamParserOptions) {
        this.onEvent = opts.onEvent
        this.onSkip = opts.onSkip
        this.logger = opts.logger?.child({ component: 'stream-parser' })
    }

    /**
     * Feed a chunk from the docker attach stream. Splits on `\n` and
     * dispatches every complete line; partial trailing data is held
     * in the buffer until the next chunk closes it.
     */
    push(chunk: Buffer | string): void {
        this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let newline = this.buffer.indexOf('\n')
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline)
            this.buffer = this.buffer.slice(newline + 1)
            this.dispatch(line)
            newline = this.buffer.indexOf('\n')
        }
    }

    /**
     * Flush whatever remains in the buffer. Called when the stream
     * closes — anything left without a trailing newline is best-effort
     * (likely truncated by a SIGKILL mid-write).
     */
    end(): void {
        if (this.buffer.length > 0) {
            this.dispatch(this.buffer)
            this.buffer = ''
        }
    }

    private dispatch(raw: string): void {
        const line = raw.trim()
        if (line.length === 0) {
            this.onSkip?.('empty_line', raw)
            return
        }
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            this.onEvent(parsed)
        } catch (err) {
            this.onSkip?.('invalid_json', line)
            this.logger?.warn(
                {
                    line: line.slice(0, 200),
                    err: err instanceof Error ? err.message : String(err),
                },
                'skipped non-JSON line on agent stream'
            )
        }
    }
}
