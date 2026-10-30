/**
 * Minimal JSON logs to stdout. Callers pass ids, hosts, codes and statuses:
 * never credential values, header values or bodies.
 */

export type KeychainLog = (
    level: 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, string | number | boolean | null>
) => void

export const log: KeychainLog = (level, msg, fields = {}) => {
    const line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        service: 'kj-keychain',
        msg,
        ...fields,
    })
    if (level === 'error') console.error(line)
    else console.log(line)
}

export const silentLog: KeychainLog = () => {}
