const PREFIX = "[cache-keepalive]"

export class Logger {
    constructor(private readonly debug: boolean) {}

    info(message: string, data?: unknown) {
        if (this.debug) console.log(`${PREFIX} ${message}`, data ?? "")
    }

    warn(message: string, data?: unknown) {
        console.warn(`${PREFIX} ${message}`, data ?? "")
    }

    error(message: string, data?: unknown) {
        console.error(`${PREFIX} ${message}`, data ?? "")
    }

    dbg(message: string, data?: unknown) {
        if (this.debug) console.log(`${PREFIX}:debug ${message}`, data ?? "")
    }
}
