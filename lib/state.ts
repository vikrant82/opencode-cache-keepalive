import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { KeepaliveConfig } from "./config"
import { stateFilePath } from "./paths"

export type PingRecord = {
    at: number
    hit: boolean
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
}

/** Live per-session bookkeeping held by the server plugin. */
export type SessionKeepalive = {
    sessionID: string
    /** Whether the session's provider/model pair supports cache warming. */
    eligible: boolean
    modelLabel?: string
    /** Epoch ms of the last real assistant response (excludes ping replies). */
    lastResponseAt: number
    /** Epoch ms the current idle stretch began. */
    idleSince: number
    /** Epoch ms after which warming stops and the cache is allowed to go cold. */
    windowEndsAt: number
    /** Epoch ms the next ping is due. */
    nextPingAt: number
    /** Number of scheduled ping requests attempted during this warm window. */
    pingsSent: number
    /** A real turn is currently running. */
    busy: boolean
    /** A keepalive ping is currently in flight. */
    warming: boolean
    /** Within the warm window and actively scheduling pings. */
    active: boolean
    /** Epoch ms of the last ping; retained only to ignore its late events. */
    lastPingAt?: number
    lastPing?: PingRecord
}

/** Lean projection persisted to disk for the TUI reader. */
export type PersistedSession = {
    eligible: boolean
    modelLabel?: string
    lastResponseAt: number
    idleSince: number
    windowEndsAt: number
    nextPingAt: number
    intervalMs: number
    pingsSent: number
    busy: boolean
    warming: boolean
    active: boolean
    lastPing?: PingRecord
}

export type PersistedState = {
    version: 1
    updatedAt: number
    enabled: boolean
    intervalMs: number
    windowMs: number
    sessions: Record<string, PersistedSession>
}

export class KeepaliveStore {
    private readonly sessions = new Map<string, SessionKeepalive>()
    private writeQueue: Promise<void> = Promise.resolve()
    private enabled: boolean

    constructor(
        private readonly config: KeepaliveConfig,
        private readonly directory: string,
    ) {
        this.enabled = config.enabled
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled
    }

    get(sessionID: string): SessionKeepalive | undefined {
        return this.sessions.get(sessionID)
    }

    ensure(sessionID: string): SessionKeepalive {
        const existing = this.sessions.get(sessionID)
        if (existing) return existing
        const created: SessionKeepalive = {
            sessionID,
            eligible: false,
            lastResponseAt: 0,
            idleSince: 0,
            windowEndsAt: 0,
            nextPingAt: 0,
            pingsSent: 0,
            busy: false,
            warming: false,
            active: false,
        }
        this.sessions.set(sessionID, created)
        return created
    }

    remove(sessionID: string): void {
        this.sessions.delete(sessionID)
    }

    all(): SessionKeepalive[] {
        return [...this.sessions.values()]
    }

    /** Atomically persist a lean snapshot for the TUI. Never throws to callers. */
    persist(): void {
        const snapshot: PersistedState = {
            version: 1,
            updatedAt: Date.now(),
            enabled: this.enabled,
            intervalMs: this.config.intervalMs,
            windowMs: this.config.windowMs,
            sessions: Object.fromEntries(
                this.all().map((s) => [
                    s.sessionID,
                    {
                        eligible: s.eligible,
                        modelLabel: s.modelLabel,
                        lastResponseAt: s.lastResponseAt,
                        idleSince: s.idleSince,
                        windowEndsAt: s.windowEndsAt,
                        nextPingAt: s.nextPingAt,
                        intervalMs: this.config.intervalMs,
                        pingsSent: s.pingsSent,
                        busy: s.busy,
                        warming: s.warming,
                        active: s.active,
                        lastPing: s.lastPing,
                    } satisfies PersistedSession,
                ]),
            ),
        }

        const write = () => atomicWrite(stateFilePath(this.directory), JSON.stringify(snapshot))
        this.writeQueue = this.writeQueue.then(write, write)
    }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
    try {
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, `${contents}\n`, "utf8")
        await rename(tmp, path)
    } catch {
        // Persistence is best-effort; the TUI readout simply falls behind.
    }
}
