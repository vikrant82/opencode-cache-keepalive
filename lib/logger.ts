import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const PREFIX = "[cache-keepalive]"

export class Logger {
    private readonly logPath: string
    private readonly debug: boolean
    private initialized = false

    constructor(debug: boolean, logPath: string) {
        this.debug = debug
        this.logPath = logPath
    }

    info(message: string, data?: unknown) {
        this.write("INFO", message, data)
    }

    warn(message: string, data?: unknown) {
        this.write("WARN", message, data)
    }

    error(message: string, data?: unknown) {
        this.write("ERROR", message, data)
    }

    dbg(message: string, data?: unknown) {
        if (this.debug) this.write("DEBUG", message, data)
    }

    private write(level: string, message: string, data?: unknown): void {
        const ts = new Date().toISOString()
        const extra =
            data !== undefined ? ` ${typeof data === "string" ? data : JSON.stringify(data)}` : ""
        const line = `${ts} ${level} ${PREFIX} ${message}${extra}\n`
        try {
            if (!this.initialized) {
                mkdirSync(dirname(this.logPath), { recursive: true })
                this.initialized = true
            }
            appendFileSync(this.logPath, line, "utf8")
        } catch {
            // Best-effort logging — never crash the plugin.
        }
    }
}
