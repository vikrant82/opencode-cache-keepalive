import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync, unlinkSync } from "node:fs"
import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Logger } from "./logger"
import { instanceStateFilePath, stateDirectoryKey, stateDirectoryPath } from "./paths"
import type { ProcessTotals, SessionWarmEntry, WarmStateSink } from "./types"

const CLEANUP_INTERVAL_MS = 10 * 60_000
const PERSIST_DEBOUNCE_MS = 250

type StateFile = {
    version: 2
    pid: number
    instanceId: string
    updatedAt: number
    sessions: Record<string, SessionWarmEntry>
    totals: ProcessTotals
}

export type StateStoreOptions = { logger?: Logger; now?: () => number }

/**
 * Create an isolated v2 snapshot writer. Mutations are debounced, dispose flushes
 * the latest snapshot before removing it, and all filesystem failures stay
 * best-effort so state reporting cannot disrupt replay execution.
 */
export function createStateStore(
    directory: string,
    options: StateStoreOptions = {},
): WarmStateSink {
    const now = options.now ?? Date.now
    const instanceId = randomUUID()
    const filePath = instanceStateFilePath(directory, process.pid, instanceId)
    const sessions = new Map<string, SessionWarmEntry>()
    let totals: ProcessTotals = {
        replays: 0,
        avoidedTokens: 0,
        replayReadTokens: 0,
        resumeHits: 0,
        resumeMisses: 0,
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let cleanupTimer: ReturnType<typeof setInterval> | undefined
    let writeQueue: Promise<void> = Promise.resolve()
    let disposed = false

    const flush = (): Promise<void> => {
        if (timer) clearTimeout(timer)
        timer = undefined
        const snapshot: StateFile = {
            version: 2,
            pid: process.pid,
            instanceId,
            updatedAt: now(),
            sessions: Object.fromEntries(sessions),
            totals,
        }
        const write = () => atomicWrite(filePath, JSON.stringify(snapshot))
        writeQueue = writeQueue.then(write, write)
        return writeQueue
    }

    const schedule = () => {
        if (disposed || timer) return
        timer = setTimeout(() => {
            timer = undefined
            void flush()
        }, PERSIST_DEBOUNCE_MS)
    }

    const onExit = () => {
        try {
            unlinkSync(filePath)
        } catch {
            // Exit cleanup is best-effort.
        }
    }

    cleanupStateFiles(directory, options.logger)
    cleanupTimer = setInterval(
        () => cleanupStateFiles(directory, options.logger),
        CLEANUP_INTERVAL_MS,
    )
    process.on("exit", onExit)

    return {
        upsert(entry) {
            if (disposed) return
            sessions.set(entry.sessionID, { ...entry })
            schedule()
        },
        remove(sessionID) {
            if (disposed) return
            sessions.delete(sessionID)
            schedule()
        },
        setTotals(value) {
            if (disposed) return
            totals = { ...value }
            schedule()
        },
        async dispose() {
            if (disposed) return
            disposed = true
            if (timer) clearTimeout(timer)
            timer = undefined
            if (cleanupTimer) clearInterval(cleanupTimer)
            cleanupTimer = undefined
            process.off("exit", onExit)
            await flush()
            await unlink(filePath).catch(() => {})
        },
    }
}

/** Return the newest self-contained entry for a session across matching v2 files. */
export function readSessionEntry(
    directory: string,
    sessionID: string,
): SessionWarmEntry | undefined {
    let freshest: SessionWarmEntry | undefined
    for (const snapshot of readSnapshots(directory)) {
        const entry = snapshot.sessions[sessionID]
        if (entry && (!freshest || entry.updatedAt > freshest.updatedAt)) freshest = entry
    }
    return freshest
}

/** Sum process-level totals from live snapshots for this directory. */
export function readProcessTotals(directory: string): ProcessTotals {
    const totals = {
        replays: 0,
        avoidedTokens: 0,
        replayReadTokens: 0,
        resumeHits: 0,
        resumeMisses: 0,
    }
    for (const snapshot of readSnapshots(directory)) {
        totals.replays += snapshot.totals.replays
        totals.avoidedTokens += snapshot.totals.avoidedTokens
        totals.replayReadTokens += snapshot.totals.replayReadTokens
        totals.resumeHits += snapshot.totals.resumeHits
        totals.resumeMisses += snapshot.totals.resumeMisses
    }
    return totals
}

/** Remove only v2 snapshots whose owner PID is confirmed dead. */
export function cleanupStateFiles(directory: string, logger?: Logger): void {
    try {
        const prefix = `state-v2-${stateDirectoryKey(directory)}-`
        for (const name of readdirSync(stateDirectoryPath())) {
            const match = name.match(new RegExp(`^${prefix}(\\d+)-[^/]+\\.json$`))
            if (!match) continue
            const pid = Number(match[1])
            try {
                process.kill(pid, 0)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                    unlinkSync(join(stateDirectoryPath(), name))
                    logger?.dbg("Removed stale state snapshot", { pid })
                }
            }
        }
    } catch {
        // Storage can be unavailable during startup/shutdown; cleanup is optional.
    }
}

function readSnapshots(directory: string): StateFile[] {
    const prefix = `state-v2-${stateDirectoryKey(directory)}-`
    try {
        return readdirSync(stateDirectoryPath())
            .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
            .map((name) => {
                try {
                    const value = JSON.parse(
                        readFileSync(join(stateDirectoryPath(), name), "utf8"),
                    ) as StateFile
                    return value.version === 2 && value.sessions && value.totals ? value : undefined
                } catch {
                    return undefined
                }
            })
            .filter((value): value is StateFile => value !== undefined)
    } catch {
        return []
    }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
    try {
        const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, `${contents}\n`, "utf8")
        await rename(tmp, path)
    } catch {
        // Best-effort persistence; stale display data is safer than disrupting replay.
    }
}
