import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { controlFilePath } from "../lib/paths"
import { readSessionControl, setSessionEnabled } from "../lib/control"

let dataHome: string
let previousDataHome: string | undefined

beforeEach(async () => {
    previousDataHome = process.env.XDG_DATA_HOME
    dataHome = await mkdtemp(join(tmpdir(), "keepalive-control-test-"))
    process.env.XDG_DATA_HOME = dataHome
})

afterEach(async () => {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    await rm(dataHome, { recursive: true, force: true })
})

test("legacy folder-level v1 disabled control is ignored", async () => {
    const directory = "/tmp/control-legacy"
    const path = controlFilePath(directory)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(dataHome, "opencode/storage/plugin/keepalive"), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, enabled: false, updatedAt: 10 }))

    assert.equal(readSessionControl(directory, "session-a"), undefined)
})

test("setting one session key preserves other sessions and prunes controls older than thirty days", async () => {
    const directory = "/tmp/control-write"
    const path = controlFilePath(directory)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(dataHome, "opencode/storage/plugin/keepalive"), { recursive: true })
    const now = 2_000_000_000_000
    await writeFile(
        path,
        JSON.stringify({
            version: 2,
            sessions: {
                preserved: { enabled: true, updatedAt: now - 5 },
                stale: { enabled: false, updatedAt: now - 30 * 24 * 60 * 60 * 1000 - 1 },
            },
        }),
    )

    const result = await setSessionEnabled(directory, "changed", false, now)
    const persisted = JSON.parse(await readFile(path, "utf8"))
    assert.deepEqual(Object.keys(result.sessions).sort(), ["changed", "preserved"])
    assert.deepEqual(Object.keys(persisted.sessions).sort(), ["changed", "preserved"])
    assert.deepEqual(persisted.sessions.changed, { enabled: false, updatedAt: now })
    assert.deepEqual(persisted.sessions.preserved, { enabled: true, updatedAt: now - 5 })
})
