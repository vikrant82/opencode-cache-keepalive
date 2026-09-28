import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test, type TestContext } from "node:test"
import { getConfig } from "../lib/config"
import { controlFilePath, stateFilePath } from "../lib/paths"
import { KeepaliveEngine } from "../lib/keepalive"
import { Logger } from "../lib/logger"
import { KeepaliveStore, type PersistedState } from "../lib/state"
import { readControl, updateControl, writeControl } from "../lib/control"

const NOW = 1_700_000_000_000
const DIR = "/tmp/interval-project"
const CONFIG_INTERVAL = 120_000
const OVERRIDE = 60_000

let context: TestContext
let dataHome: string
let oldDataHome: string | undefined
let engine: KeepaliveEngine | undefined
let store: KeepaliveStore | undefined
let client: IntervalClient

beforeEach(async (t) => {
    context = t as TestContext
    oldDataHome = process.env.XDG_DATA_HOME
    dataHome = await mkdtemp(join(tmpdir(), "keepalive-interval-"))
    process.env.XDG_DATA_HOME = dataHome
    context.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW })
    context.mock.method(Math, "random", () => 0.5)
    client = new IntervalClient()
})

afterEach(async () => {
    engine?.stop()
    await store?.persist()
    engine = undefined
    context.mock.timers.reset()
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldDataHome
    await rm(dataHome, { recursive: true, force: true })
})

test("runtime interval override reschedules armed sessions sooner and later", async () => {
    startEngine(CONFIG_INTERVAL)
    await realTurn(engine!, "sooner")
    await updateControl(DIR, { intervalMs: OVERRIDE })
    await tick(1_000)
    await tick(60_000)
    assert.equal(client.prompts.filter((args) => args.path.id === "sooner").length, 1)

    await realTurn(engine!, "later")
    await updateControl(DIR, { intervalMs: 300_000 })
    await tick(1_000)
    await tick(120_000)
    assert.equal(client.prompts.filter((args) => args.path.id === "later").length, 0)
    await tick(180_000)
    assert.equal(client.prompts.filter((args) => args.path.id === "later").length, 1)
})

test("startup interval override governs the first ping", async () => {
    await updateControl(DIR, { intervalMs: OVERRIDE })
    startEngine(CONFIG_INTERVAL)
    await realTurn(engine!, "startup")
    await tick(60_000)
    assert.equal(client.prompts.length, 1)
})

test("clearing interval override restores the configured interval", async () => {
    await updateControl(DIR, { intervalMs: 300_000 })
    startEngine(CONFIG_INTERVAL)
    await realTurn(engine!, "clear")
    await updateControl(DIR, { intervalMs: null })
    await tick(1_000)
    await tick(CONFIG_INTERVAL)
    assert.equal(client.prompts.length, 1)
})

test("persisted state reports the effective runtime interval", async () => {
    startEngine(CONFIG_INTERVAL)
    await realTurn(engine!, "effective")
    await updateControl(DIR, { intervalMs: 300_000 })
    await tick(1_000)
    await store!.persist()
    const state = await persisted()
    assert.equal(state.intervalMs, 300_000)
    assert.equal(state.sessions.effective.intervalMs, 300_000)
})

test("control updates preserve unrelated enabled and interval fields", async () => {
    await updateControl(DIR, { enabled: true, intervalMs: 300_000 })
    await writeControl(false, DIR)
    assert.deepEqual(readControl(DIR), {
        version: 1,
        enabled: false,
        intervalMs: 300_000,
        updatedAt: NOW + 1,
    })
    await updateControl(DIR, { intervalMs: OVERRIDE })
    assert.equal(readControl(DIR)?.enabled, false)
    assert.equal(readControl(DIR)?.intervalMs, OVERRIDE)
})

test("invalid interval updates throw and leave control file unchanged", async () => {
    const original = await updateControl(DIR, { enabled: true, intervalMs: OVERRIDE })
    await assert.rejects(updateControl(DIR, { intervalMs: 59_999 }), RangeError)
    await assert.rejects(updateControl(DIR, { intervalMs: 24 * 3_600_000 + 1 }), RangeError)
    assert.deepEqual(readControl(DIR), original)
})

test("reader ignores an out-of-range interval but keeps enabled state", async () => {
    await mkdir(join(dataHome, "opencode/storage/plugin/keepalive"), { recursive: true })
    await writeFile(
        controlFilePath(DIR),
        JSON.stringify({ version: 1, enabled: false, intervalMs: 1, updatedAt: NOW }),
    )
    assert.deepEqual(readControl(DIR), { version: 1, enabled: false, updatedAt: NOW })
})

test("same-millisecond control writes are both observed by the engine", async () => {
    startEngine(CONFIG_INTERVAL)
    await realTurn(engine!, "same-time")
    const disabled = await writeControl(false, DIR)
    const updated = await updateControl(DIR, { intervalMs: 300_000 })
    assert.ok(updated.updatedAt > disabled.updatedAt)
    await tick(1_000)
    const state = await persisted()
    assert.equal(state.enabled, false)
    assert.equal(state.intervalMs, 300_000)
})

function startEngine(intervalMs: number): void {
    const config = getConfig({ intervalMs, windowMs: 900_000, revertPing: false })
    store = new KeepaliveStore(config, DIR)
    engine = new KeepaliveEngine(
        client,
        config,
        store,
        new Logger(false, join(dataHome, "server.log")),
        DIR,
    )
    engine.start()
}

async function realTurn(instance: KeepaliveEngine, id: string): Promise<void> {
    await instance.onEvent({
        type: "message.updated",
        properties: {
            info: {
                id: `${id}-user`,
                sessionID: id,
                role: "user",
                time: { created: Date.now() },
                agent: "plan",
                model: { providerID: "github-copilot", modelID: "claude-opus-5.5" },
            },
        },
    })
    await instance.onEvent({
        type: "session.status",
        properties: { sessionID: id, status: { type: "busy" } },
    })
    await instance.onEvent({
        type: "message.updated",
        properties: {
            info: {
                id: `${id}-assistant`,
                sessionID: id,
                role: "assistant",
                parentID: `${id}-user`,
                time: { created: Date.now(), completed: Date.now() },
            },
        },
    })
    await instance.onEvent({
        type: "session.status",
        properties: { sessionID: id, status: { type: "idle" } },
    })
}

async function tick(ms: number): Promise<void> {
    context.mock.timers.tick(ms)
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function persisted(): Promise<PersistedState> {
    await store!.persist()
    return JSON.parse(await readFile(stateFilePath(DIR), "utf8")) as PersistedState
}

class IntervalClient {
    prompts: any[] = []
    session = {
        get: async ({ path }: any) => ({
            data: { id: path.id, model: { providerID: "github-copilot", id: "claude-opus-5.5" } },
        }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        prompt: async (args: any) => {
            this.prompts.push(args)
            return { data: { info: { time: { completed: Date.now() }, tokens: {} } } }
        },
        revert: async () => ({ data: {} }),
    }
}
