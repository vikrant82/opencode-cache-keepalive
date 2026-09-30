import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { instanceStateFilePath, stateDirectoryKey, stateDirectoryPath } from "../lib/paths"
import {
    cleanupStateFiles,
    createStateStore,
    readProcessTotals,
    readSessionEntry,
} from "../lib/state"
import type { ProcessTotals, SessionWarmEntry } from "../lib/types"

const DIR = "/tmp/shared-project"
let dataHome: string
let oldDataHome: string | undefined
let stores: Array<ReturnType<typeof createStateStore>> = []

beforeEach(async () => {
    oldDataHome = process.env.XDG_DATA_HOME
    dataHome = await mkdtemp(join(tmpdir(), "replay-state-test-"))
    process.env.XDG_DATA_HOME = dataHome
    stores = []
})

afterEach(async () => {
    for (const store of stores) await store.dispose()
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldDataHome
    await rm(dataHome, { recursive: true, force: true })
})

test("two instances publish independent sessions resolved by the directory reader", async () => {
    const first = createStore()
    const second = createStore()
    first.upsert(entry("session-a", 10))
    second.upsert(entry("session-b", 20))
    await flush(first)
    await flush(second)

    assert.equal(readSessionEntry(DIR, "session-a")?.gapId, 10)
    assert.equal(readSessionEntry(DIR, "session-b")?.gapId, 20)
})

test("reader picks the freshest entry for a duplicate session", async () => {
    const first = createStore()
    const second = createStore()
    first.upsert(entry("shared", 1, 100))
    second.upsert(entry("shared", 2, 200))
    await flush(first)
    await flush(second)

    assert.equal(readSessionEntry(DIR, "shared")?.gapId, 2)
})

test("reader ignores v1 and legacy snapshots", async () => {
    const store = createStore()
    store.upsert(entry("current", 7, 500))
    await flush(store)
    const legacyPrefix = `state-${stateDirectoryKey(DIR)}`
    await writeFile(
        join(stateDirectoryPath(), `${legacyPrefix}.json`),
        JSON.stringify({ version: 1, sessions: { current: entry("current", 99, 900) } }),
    )
    await writeFile(
        join(stateDirectoryPath(), `${legacyPrefix}-123-old.json`),
        JSON.stringify({ version: 1, sessions: { current: entry("current", 88, 800) } }),
    )

    assert.equal(readSessionEntry(DIR, "current")?.gapId, 7)
})

test("dead-pid v2 cleanup retains files owned by a live pid", async () => {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"])
    assert.equal(dead.status, 0)
    const deadFile = instanceStateFilePath(DIR, dead.pid!, "dead")
    const liveFile = instanceStateFilePath(DIR, process.pid, "live")
    await mkdir(stateDirectoryPath(), { recursive: true })
    await writeFile(deadFile, "{}")
    await writeFile(liveFile, "{}")
    cleanupStateFiles(DIR)

    await assert.rejects(readFile(deadFile, "utf8"), { code: "ENOENT" })
    assert.equal(await readFile(liveFile, "utf8"), "{}")
})

test("dispose removes the store's own v2 snapshot", async () => {
    const store = createStore()
    store.upsert(entry("gone", 1))
    await flush(store)
    const before = new Set(await readdir(stateDirectoryPath()))
    store.upsert(entry("another", 2))
    await flush(store)
    const created = (await readdir(stateDirectoryPath())).filter((name) => !before.has(name))
    assert.equal(created.length, 0)
    const ownFile = (await readdir(stateDirectoryPath())).find((name) =>
        name.includes(`-${process.pid}-`),
    )
    assert.ok(ownFile)
    await store.dispose()
    stores = []
    await assert.rejects(readFile(join(stateDirectoryPath(), ownFile), "utf8"), { code: "ENOENT" })
})

test("debounced persistence writes the latest entry and only safe fields", async () => {
    const store = createStore()
    store.upsert(entry("latest", 1, 10))
    store.upsert(entry("latest", 2, 20))
    await flush(store)
    const [name] = await readdir(stateDirectoryPath())
    const persisted = await readFile(join(stateDirectoryPath(), name), "utf8")
    const snapshot = JSON.parse(persisted)
    assert.equal(snapshot.sessions.latest.gapId, 2)
    assert.equal(snapshot.version, 2)
    for (const sentinel of ["https://", "authorization", "secret-body", "conversation text"])
        assert.equal(persisted.includes(sentinel), false)
})

test("process totals aggregate avoided and replay-read tokens", async () => {
    const first = createStore()
    const second = createStore()
    const totalsA: ProcessTotals = {
        replays: 2,
        avoidedTokens: 100,
        replayReadTokens: 80,
        resumeHits: 1,
        resumeMisses: 0,
    }
    const totalsB: ProcessTotals = {
        replays: 3,
        avoidedTokens: 0,
        replayReadTokens: 120,
        resumeHits: 0,
        resumeMisses: 1,
    }
    first.setTotals(totalsA)
    second.setTotals(totalsB)
    await flush(first)
    await flush(second)

    assert.deepEqual(readProcessTotals(DIR), {
        replays: 5,
        avoidedTokens: 100,
        replayReadTokens: 200,
        resumeHits: 1,
        resumeMisses: 1,
    })
})

async function flush(store: ReturnType<typeof createStateStore>): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Ensure the scheduled debounce callback has had time to complete its atomic rename.
    if (!store) throw new Error("unreachable")
}

function createStore(): ReturnType<typeof createStateStore> {
    const store = createStateStore(DIR, { now: () => 1_700_000_000_000 })
    stores.push(store)
    return store
}

function entry(sessionID: string, gapId: number, updatedAt = gapId): SessionWarmEntry {
    return {
        sessionID,
        updatedAt,
        enabled: true,
        model: "claude-test",
        api: "messages",
        state: "idle",
        gapId,
        gapReplays: 1,
        cap: 9,
        nextReplayAt: 1_700_000_285_000,
        sessionReplays: 1,
        avoidedTokens: 0,
        resumeHits: 0,
        resumeCount: 0,
    }
}
