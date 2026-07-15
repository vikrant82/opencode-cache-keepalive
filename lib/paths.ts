import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Absolute path to the JSON state file shared between the server plugin (writer)
 * and the TUI plugin (reader). Both processes run on the same machine, so a file
 * under opencode's plugin storage dir is the simplest cross-process channel.
 *
 * Mirrors the storage layout used by other opencode plugins:
 *   <XDG_DATA_HOME | ~/.local/share>/opencode/storage/plugin/keepalive/state.json
 */
export function stateFilePath(directory: string): string {
    const key = createHash("sha256").update(directory).digest("hex").slice(0, 16)
    return join(stateDirectoryPath(), `state-${key}.json`)
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

/** Runtime on/off control written by the TUI and read by the server plugin. */
export function controlFilePath(): string {
    return join(stateDirectoryPath(), "control.json")
}
