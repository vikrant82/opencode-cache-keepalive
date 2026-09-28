import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test, type TestContext } from "node:test"
import { KeepaliveEngine } from "../lib/keepalive"
import { getConfig } from "../lib/config"
import { writeControl } from "../lib/control"
import { Logger } from "../lib/logger"
import { stateFilePath } from "../lib/paths"
import { KeepaliveStore, type PersistedState } from "../lib/state"

const NOW = 1_700_000_000_000
const INTERVAL = 60_000
const WINDOW = 600_000
const DIRECTORY = "/tmp/project-x"
const SESSION = "session-1"

type Message = {
    info: { id: string; role: string; parentID?: string; time: { created: number } }
    parts: { type: string; text?: string }[]
}

type Harness = {
    engine: KeepaliveEngine
    client: FakeClient
    store: KeepaliveStore
    dataHome: string
}

let harness: Harness
let previousDataHome: string | undefined

beforeEach(async (t) => {
    currentTestContext = t as TestContext
    previousDataHome = process.env.XDG_DATA_HOME
    const dataHome = await mkdtemp(join(tmpdir(), "keepalive-test-"))
    process.env.XDG_DATA_HOME = dataHome
    ;(t as TestContext).mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW })
    ;(t as TestContext).mock.method(Math, "random", () => 0.5)
    const config = getConfig({ intervalMs: INTERVAL, windowMs: WINDOW, revertPing: true })
    const store = new KeepaliveStore(config, DIRECTORY)
    const client = new FakeClient()
    const engine = new KeepaliveEngine(
        client,
        config,
        store,
        new Logger(false, join(dataHome, "server.log")),
        DIRECTORY,
    )
    harness = { engine, client, store, dataHome }
    engine.start()
})

afterEach(async (t) => {
    harness.engine.stop()
    ;(t as TestContext).mock.timers.reset()
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    await rm(harness.dataHome, { recursive: true, force: true })
})

test("ping replays the last real turn's agent, model, and variant", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION, NOW, "plan", "xhigh")

    await tick(INTERVAL + 15_000)

    assert.equal(client.prompts.length, 1)
    assert.deepEqual(client.prompts[0].body, {
        parts: [{ type: "text", text: "~" }],
        agent: "plan",
        model: { providerID: "github-copilot", modelID: "claude-opus-5.5" },
        variant: "xhigh",
    })
})

test("long silent busy step sends no ping and does not block tools", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION)
    await emitUserMessage(engine, SESSION, "working", Date.now() + 1)
    client.busy[SESSION] = true
    await engine.onEvent(statusEvent(SESSION, "busy"))

    await tick(20 * 60_000)

    assert.equal(client.prompts.length, 0)
    assert.equal(engine.shouldBlockTools(SESSION), false)
    const session = (await persisted()).sessions[SESSION]
    assert.equal(session.busy, true)
    assert.equal(session.active, false)
})

test("pre-flight busy status prevents a due ping and deactivates the session", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION)
    client.busy[SESSION] = true

    await tick(INTERVAL + 15_000)

    assert.equal(client.prompts.length, 0)
    const session = (await persisted()).sessions[SESSION]
    assert.equal(session.busy, true)
    assert.equal(session.active, false)
})

test("host sleep beyond the cold threshold stops warming without catch-up pings", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION)
    await tick(INTERVAL + 15_000)
    assert.equal(client.prompts.length, 1)

    currentTestContext!.mock.timers.setTime(Date.now() + 2 * INTERVAL + 1)
    await tick(15_000)

    assert.equal(client.prompts.length, 1)
    assert.equal((await persisted()).sessions[SESSION].active, false)
})

test("moderately overdue ping fires once and is not repeated on the next tick", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION)
    currentTestContext!.mock.timers.setTime(NOW + INTERVAL * 1.5)
    await tick(15_000)
    assert.equal(client.prompts.length, 1)

    await tick(15_000)
    assert.equal(client.prompts.length, 1)
})

test("stale assistant response is not armed by an idle status event", async () => {
    const { engine, client } = harness
    const old = NOW - 3 * 60 * 60_000
    await engine.onEvent(assistantDone(SESSION, "old-answer", "old-user", old))
    await engine.onEvent(statusEvent(SESSION, "idle"))
    assert.equal((await persisted()).sessions[SESSION].active, false)

    await tick(INTERVAL * 2)

    assert.equal(client.prompts.length, 0)
    assert.equal((await persisted()).sessions[SESSION].active, false)
})

test("runtime re-enable arms only sessions whose responses are still recent", async () => {
    const { engine, client } = harness
    await realTurn(engine, "recent", NOW)
    await writeControl(false, DIRECTORY)
    await tick(1_000)
    await realTurn(engine, "old", NOW - 3 * 60 * 60_000)
    await engine.onEvent(statusEvent("old", "idle"))
    currentTestContext!.mock.timers.setTime(NOW + 2_000)
    await writeControl(true, DIRECTORY)
    await tick(1_000)

    const sessions = (await persisted()).sessions
    assert.equal(sessions.recent.active, true)
    assert.equal(sessions.old.active, false)
    assert.equal(client.prompts.length, 0)
})

test("real user message interrupts an in-flight ping and its settings drive the next ping", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION, NOW, "plan", "xhigh")
    const pending = deferred<any>()
    client.promptResult = pending.promise
    client.onPrompt = async () =>
        emitUserMessage(engine, SESSION, "ping-user", Date.now(), "plan", "xhigh", "~")
    await tick(INTERVAL + 15_000)
    await flush()

    assert.equal(engine.shouldBlockTools(SESSION), true)
    await engine.onEvent(userMessage(SESSION, "real-user", Date.now() + 1, "build", "high"))
    assert.equal(engine.shouldBlockTools(SESSION), false)
    pending.resolve(promptResponse(Date.now() + 2))
    await flush()
    assert.equal(client.reverts.length, 0)
    assert.equal((await persisted()).sessions[SESSION].lastResponseAt, Date.now() + 2)

    await tick(INTERVAL + 15_000)
    assert.equal(client.prompts.length, 2)
    assert.equal(client.prompts[1].body.variant, "high")
})

test("real user message before ping message interrupts and preserves real request settings", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION, NOW, "plan", "xhigh")
    const pending = deferred<any>()
    client.promptResult = pending.promise
    client.onPrompt = async () => {
        await emitUserMessage(
            engine,
            SESSION,
            "real-user-first",
            Date.now() + 1,
            "build",
            "high",
            "hello",
        )
        assert.equal(engine.shouldBlockTools(SESSION), false)
        await emitUserMessage(
            engine,
            SESSION,
            "ping-user-late",
            Date.now() + 2,
            "plan",
            "xhigh",
            "~",
        )
    }
    await tick(INTERVAL + 15_000)
    await flush()
    pending.resolve(promptResponse(Date.now() + 3))
    await flush()

    assert.equal(client.reverts.length, 0)
    await tick(INTERVAL + 15_000)
    assert.equal(client.prompts.length, 2)
    assert.equal(client.prompts[1].body.variant, "high")
    assert.equal(client.prompts[1].body.agent, "build")
})

test("slow ping schedules its next request relative to completion", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION)
    const pending = deferred<any>()
    client.promptResult = pending.promise
    await tick(INTERVAL + 15_000)
    await flush()
    assert.equal(client.prompts.length, 1)

    currentTestContext!.mock.timers.tick(INTERVAL * 1.5)
    pending.resolve(promptResponse(Date.now()))
    await flush()
    await tick(15_000)
    assert.equal(client.prompts.length, 1)

    await tick(INTERVAL - 15_000)
    assert.equal(client.prompts.length, 2)
})

test("revert is skipped when a real user message follows the ping", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION)
    const pingTime = NOW + INTERVAL + 15_000
    client.onPrompt = async () => {
        client.messagesList = [
            message("ping-user", "user", pingTime, "~"),
            message("ping-answer", "assistant", pingTime + 1, "~", "ping-user"),
            message("real-user", "user", pingTime + 2, "hello"),
        ]
        await emitUserMessage(engine, SESSION, "ping-user", pingTime, "plan", "xhigh", "~")
    }

    await tick(INTERVAL + 15_000)

    assert.equal(client.reverts.length, 0)
})

test("revert targets the ping when only its assistant reply follows", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION)
    const pingTime = NOW + INTERVAL + 15_000
    client.onPrompt = async () => {
        client.messagesList = [
            message("real-user", "user", NOW, "hello"),
            message("real-answer", "assistant", NOW + 1, "world", "real-user"),
            message("ping-user", "user", pingTime, "~"),
            message("ping-answer", "assistant", pingTime + 1, "~", "ping-user"),
        ]
        await emitUserMessage(engine, SESSION, "ping-user", pingTime, "plan", "xhigh", "~")
    }

    await tick(INTERVAL + 15_000)

    assert.equal(client.reverts.length, 1)
    assert.equal(client.reverts[0].body.messageID, "ping-user")
})

test("re-emitted older user message does not stop scheduled warming", async () => {
    const { engine, client } = harness
    await realTurn(engine, SESSION, NOW)
    await engine.onEvent(userMessage(SESSION, `${SESSION}-user`, NOW))

    await tick(INTERVAL + 15_000)

    assert.equal(client.prompts.length, 1)
})

let currentTestContext: TestContext | undefined
afterEach(() => {
    currentTestContext = undefined
})

async function tick(ms: number): Promise<void> {
    currentTestContext!.mock.timers.tick(ms)
    await flush()
}

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function realTurn(
    engine: KeepaliveEngine,
    sessionID: string,
    at = Date.now(),
    agent = "plan",
    variant = "xhigh",
): Promise<void> {
    await emitUserMessage(engine, sessionID, `${sessionID}-user`, at, agent, variant)
    await engine.onEvent(statusEvent(sessionID, "busy"))
    await engine.onEvent(
        assistantDone(sessionID, `${sessionID}-assistant`, `${sessionID}-user`, at + 1),
    )
    await engine.onEvent(statusEvent(sessionID, "idle"))
}

async function emitUserMessage(
    engine: KeepaliveEngine,
    sessionID: string,
    id: string,
    created: number,
    agent = "plan",
    variant = "xhigh",
    text = "hello",
): Promise<void> {
    const event = userMessage(sessionID, id, created, agent, variant)
    await engine.onEvent(event)
    await engine.onEvent({
        type: "message.part.updated",
        properties: {
            sessionID,
            part: { id: `${id}-part`, sessionID, messageID: id, type: "text", text },
            time: created,
        },
    })
}

function userMessage(
    sessionID: string,
    id: string,
    created: number,
    agent = "plan",
    variant = "xhigh",
) {
    return {
        type: "message.updated",
        properties: {
            info: {
                id,
                sessionID,
                role: "user",
                time: { created },
                agent,
                model: { providerID: "github-copilot", modelID: "claude-opus-5.5", variant },
            },
        },
    }
}

function assistantDone(sessionID: string, id: string, parentID: string, completed: number) {
    return {
        type: "message.updated",
        properties: {
            info: {
                id,
                sessionID,
                role: "assistant",
                parentID,
                time: { created: completed - 1, completed },
            },
        },
    }
}

function statusEvent(sessionID: string, status: "busy" | "idle") {
    return { type: "session.status", properties: { sessionID, status: { type: status } } }
}

function message(
    id: string,
    role: string,
    created: number,
    text: string,
    parentID?: string,
): Message {
    return {
        info: { id, role, ...(parentID ? { parentID } : {}), time: { created } },
        parts: [{ type: "text", text }],
    }
}

function promptResponse(completed: number) {
    return {
        data: {
            info: {
                role: "assistant",
                time: { created: completed - 1, completed },
                tokens: { input: 10, output: 1, cache: { read: 5_000, write: 0 } },
            },
        },
    }
}

async function persisted(): Promise<PersistedState> {
    await harness.store.persist()
    return JSON.parse(await readFile(stateFilePath(DIRECTORY), "utf8")) as PersistedState
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
}

class FakeClient {
    busy: Record<string, boolean> = {}
    prompts: any[] = []
    reverts: any[] = []
    messagesList: Message[] = []
    onPrompt?: () => Promise<void>
    promptResult?: Promise<any>

    readonly session = {
        get: async ({ path }: any) => ({
            data: { id: path.id, model: { providerID: "github-copilot", id: "claude-opus-5.5" } },
        }),
        status: async () => ({
            data: Object.fromEntries(
                Object.entries(this.busy)
                    .filter(([, busy]) => busy)
                    .map(([id]) => [id, { type: "busy" }]),
            ),
        }),
        prompt: async (args: any) => {
            this.prompts.push(args)
            await this.onPrompt?.()
            return this.promptResult ?? promptResponse(Date.now())
        },
        messages: async () => ({ data: this.messagesList }),
        revert: async (args: any) => {
            this.reverts.push(args)
            return { data: {} }
        },
    }
}
