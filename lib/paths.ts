import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

/** Stable short directory key shared by that directory's state-file readers/writers. */
export function stateDirectoryKey(directory: string): string {
    return createHash("sha256").update(directory).digest("hex").slice(0, 16)
}

/** Filename for one process/plugin-instance state snapshot. */
export function instanceStateFilePath(directory: string, pid: number, instanceId: string): string {
    return join(
        stateDirectoryPath(),
        `state-v2-${stateDirectoryKey(directory)}-${pid}-${instanceId}.json`,
    )
}

export function stateDirectoryPath(): string {
    return join(
        process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "keepalive",
    )
}

/**
 * Session runtime controls are stored by directory, with entries keyed by session ID.
 */
export function controlFilePath(directory: string): string {
    const key = createHash("sha256").update(directory).digest("hex").slice(0, 16)
    return join(stateDirectoryPath(), `control-${key}.json`)
}

/** Append-only log file for the server plugin — never stdout, which corrupts the TUI. */
export function logFilePath(): string {
    return join(stateDirectoryPath(), "server.log")
}
