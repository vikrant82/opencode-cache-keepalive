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

/**
 * Request settings of the last real user turn. A ping must replay them exactly:
 * a prompt without explicit settings runs as opencode's default agent with no
 * variant, which changes the request shape (missing the cache) and overwrites
 * the session's persisted agent/model/variant.
 */
export type PingRequest = {
    agent?: string
    providerID: string
    modelID: string
    variant?: string
}

/** Bookkeeping for the ping request currently in flight. */
export type InflightPing = {
    /** Epoch ms the ping attempt began (before the pre-flight status check). */
    startedAt: number
    /** The prompt request has been issued. */
    sent: boolean
    /** The ping's own user message, identified by its ping-token text part. */
    messageID?: string
    /**
     * New user messages seen during the ping whose text has not yet been observed.
     * Each is classified by its first text part: the ping token marks our own
     * message, anything else a real turn.
     */
    pending: Map<string, unknown>
    /**
     * A real user message appeared while the ping was in flight. opencode joins such
     * a prompt to the running ping loop, so the rest of the run is real work.
     */
    interrupted: boolean
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
    /** The in-flight ping; set exactly while `warming` is true. */
    ping?: InflightPing
    /** ID and creation time of the newest user message seen, to tell new turns from re-emitted old messages. */
    lastUserID?: string
    lastUserAt?: number
    /** Settings of the last real user turn, replayed by pings. */
    request?: PingRequest
    /** Within the warm window and actively scheduling pings. */
    active: boolean
    /** True while `armWindow` is resolving session metadata (async guard). */
    arming?: boolean
    /** Epoch ms the last sent ping finished; ignores its late events and marks the last cache touch. */
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
    private intervalMs: number

    constructor(
        private readonly config: KeepaliveConfig,
        private readonly directory: string,
    ) {
        this.enabled = config.enabled
        this.intervalMs = config.intervalMs
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled
    }

    /** Effective ping interval (runtime override or config) reported to the TUI. */
    setIntervalMs(intervalMs: number): void {
        this.intervalMs = intervalMs
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

    /**
     * Atomically persist a lean snapshot for the TUI. Never throws or rejects; the
     * returned promise resolves once this snapshot and every earlier one are written.
     */
    persist(): Promise<void> {
        const snapshot: PersistedState = {
            version: 1,
            updatedAt: Date.now(),
            enabled: this.enabled,
            intervalMs: this.intervalMs,
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
                        intervalMs: this.intervalMs,
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
        return this.writeQueue
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
