import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { controlFilePath } from "./paths"

/** Smallest accepted runtime ping interval; below this the 15 s scheduler tick dominates. */
export const MIN_INTERVAL_MS = 60_000
/** Largest accepted runtime ping interval (sanity bound; no provider cache outlives it). */
export const MAX_INTERVAL_MS = 24 * 3_600_000

/**
 * Per-project runtime overrides written by the TUI and polled by the server plugin.
 * Absent fields mean "use the plugin configuration". Readers ignore unknown fields,
 * so older servers still honour `enabled` and ignore `intervalMs`.
 */
export type KeepaliveControl = {
    version: 1
    /** Runtime on/off override. */
    enabled?: boolean
    /** Runtime ping interval override in milliseconds. */
    intervalMs?: number
    /** Epoch ms of the last write; strictly increasing so every write is observed. */
    updatedAt: number
}

/** Changes to apply to the control file; `intervalMs: null` clears the override. */
export type ControlPatch = {
    enabled?: boolean
    intervalMs?: number | null
}

export function isValidInterval(ms: unknown): ms is number {
    return (
        typeof ms === "number" &&
        Number.isFinite(ms) &&
        ms >= MIN_INTERVAL_MS &&
        ms <= MAX_INTERVAL_MS
    )
}

/**
 * Read the directory's control file. Returns undefined when it is missing or
 * malformed; an out-of-range interval override is dropped rather than rejecting
 * the whole file. Never throws.
 */
export function readControl(directory: string): KeepaliveControl | undefined {
    try {
        const value = JSON.parse(readFileSync(controlFilePath(directory), "utf8")) as Record<
            string,
            unknown
        >
        if (value?.version !== 1 || typeof value.updatedAt !== "number") return undefined
        if (value.enabled !== undefined && typeof value.enabled !== "boolean") return undefined
        return {
            version: 1,
            updatedAt: value.updatedAt,
            ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
            ...(isValidInterval(value.intervalMs) ? { intervalMs: value.intervalMs } : {}),
        }
    } catch {
        return undefined
    }
}

/**
 * Merge `patch` into the directory's control file and write it atomically. Fields
 * not in the patch keep their current value.
 *
 * @throws RangeError when `patch.intervalMs` is outside
 *   [MIN_INTERVAL_MS, MAX_INTERVAL_MS]; filesystem errors propagate.
 */
export async function updateControl(
    directory: string,
    patch: ControlPatch,
): Promise<KeepaliveControl> {
    if (
        patch.intervalMs !== undefined &&
        patch.intervalMs !== null &&
        !isValidInterval(patch.intervalMs)
    ) {
        throw new RangeError(
            `Ping interval must be between ${MIN_INTERVAL_MS / 1000}s and ${MAX_INTERVAL_MS / 3_600_000}h`,
        )
    }

    // Serialize read-merge-write within this process so concurrent updates cannot
    // drop each other's fields. Across processes the atomic rename keeps the file
    // valid; the last writer wins.
    const run = updateQueue.then(() => writeMerged(directory, patch))
    updateQueue = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

let updateQueue: Promise<void> = Promise.resolve()

async function writeMerged(directory: string, patch: ControlPatch): Promise<KeepaliveControl> {
    const current = readControl(directory)
    const enabled = patch.enabled ?? current?.enabled
    const intervalMs =
        patch.intervalMs === null ? undefined : (patch.intervalMs ?? current?.intervalMs)
    const value: KeepaliveControl = {
        version: 1,
        ...(enabled !== undefined ? { enabled } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1),
    }
    const path = controlFilePath(directory)
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(value)}\n`, "utf8")
    await rename(tmp, path)
    return value
}

/** Set the runtime on/off override, preserving any interval override. */
export function writeControl(enabled: boolean, directory: string): Promise<KeepaliveControl> {
    return updateControl(directory, { enabled })
}
