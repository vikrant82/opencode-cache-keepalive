import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { controlFilePath } from "./paths"

const VERSION = 2
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type SessionControl = { enabled: boolean; updatedAt: number }
export type SessionControlFile = { version: 2; sessions: Record<string, SessionControl> }

/** Read current session overrides; old folder-level controls are intentionally ignored. */
export function readSessionControls(directory: string, now = Date.now()): SessionControlFile {
    try {
        const value = JSON.parse(readFileSync(controlFilePath(directory), "utf8")) as Record<
            string,
            unknown
        >
        if (value.version !== VERSION || !value.sessions || typeof value.sessions !== "object")
            return { version: VERSION, sessions: {} }
        const sessions: Record<string, SessionControl> = {}
        for (const [id, raw] of Object.entries(value.sessions)) {
            if (
                !raw ||
                typeof raw !== "object" ||
                typeof (raw as SessionControl).enabled !== "boolean" ||
                typeof (raw as SessionControl).updatedAt !== "number" ||
                (raw as SessionControl).updatedAt < now - MAX_AGE_MS
            )
                continue
            sessions[id] = {
                enabled: (raw as SessionControl).enabled,
                updatedAt: (raw as SessionControl).updatedAt,
            }
        }
        return { version: VERSION, sessions }
    } catch {
        return { version: VERSION, sessions: {} }
    }
}

export function readSessionControl(
    directory: string,
    sessionID: string,
): SessionControl | undefined {
    return readSessionControls(directory).sessions[sessionID]
}

/** Atomically update only this session key and prune expired overrides. */
export async function setSessionEnabled(
    directory: string,
    sessionID: string,
    enabled: boolean,
    now = Date.now(),
): Promise<SessionControlFile> {
    const run = updateQueue.then(() => writeSessionControl(directory, sessionID, enabled, now))
    updateQueue = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

let updateQueue: Promise<void> = Promise.resolve()

async function writeSessionControl(
    directory: string,
    sessionID: string,
    enabled: boolean,
    now: number,
): Promise<SessionControlFile> {
    const current = readSessionControls(directory, now)
    const cutoff = now - MAX_AGE_MS
    const sessions = Object.fromEntries(
        Object.entries(current.sessions).filter(([, value]) => value.updatedAt >= cutoff),
    )
    sessions[sessionID] = { enabled, updatedAt: now }
    const value: SessionControlFile = { version: VERSION, sessions }
    const path = controlFilePath(directory)
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(value)}\n`, "utf8")
    await rename(tmp, path)
    return value
}
