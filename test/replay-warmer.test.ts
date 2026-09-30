import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setSessionEnabled } from "../lib/control"
import { controlFilePath } from "../lib/paths"
import { ReplayWarmer } from "../lib/replay-warmer"
import { getConfig, type KeepaliveConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import type { ProcessTotals, SessionWarmEntry, WarmStateSink } from "../lib/types"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const NOW = 1_700_000_000_000
const SESSION = "root-session"
const SENTINEL = "never-log-this-value"
let originalFetch: typeof fetch

function fakeSink() {
    const entries = new Map<string, SessionWarmEntry>()
    let totals: ProcessTotals = {
        replays: 0,
        avoidedTokens: 0,
        replayReadTokens: 0,
        resumeHits: 0,
        resumeMisses: 0,
    }
    const sink: WarmStateSink = {
        upsert: (entry) => entries.set(entry.sessionID, structuredClone(entry)),
        remove: (id) => void entries.delete(id),
        setTotals: (value) => {
            totals = { ...value }
        },
        dispose: async () => {},
    }
    return {
        sink,
        entries,
        get totals() {
            return totals
        },
    }
}

function setup(
    t: TestContext,
    config: Partial<KeepaliveConfig> = {},
    handler?: typeof fetch,
    logger = new Logger(false, "/tmp/replay-warmer-test.log"),
) {
    const oldDataHome = process.env.XDG_DATA_HOME
    const dataHome = mkdtempSync(join(tmpdir(), "replay-warmer-data-"))
    process.env.XDG_DATA_HOME = dataHome
    originalFetch = globalThis.fetch
    delete (globalThis as any)[Symbol.for("opencode-cache-keepalive.replay-warmer")]
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        if (handler) return handler(input, init)
        if (init?.signal)
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}}\n\n',
                            ),
                        )
                    },
                }),
            )
        return new Response("ok")
    })
    const state = fakeSink()
    const directory = `/tmp/replay-warmer-test-${Math.random()}`
    const warmer = new ReplayWarmer(
        {},
        getConfig({ enabled: true }),
        state.sink,
        logger,
        directory,
        () => Date.now(),
    )
    // Config is set via public constructor contract; create a config-specific engine when needed.
    const engine = Object.keys(config).length
        ? new ReplayWarmer(
              {},
              { ...getConfig({ enabled: true }), ...config },
              state.sink,
              logger,
              directory,
              () => Date.now(),
          )
        : warmer
    engine.start()
    t.after(() => {
        engine.dispose()
        globalThis.fetch = originalFetch
        if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = oldDataHome
        rmSync(dataHome, { recursive: true, force: true })
        t.mock.timers.reset()
    })
    return { engine, state, calls, directory }
}

function realRequest(
    sessionID = SESSION,
    model = "claude-sonnet",
    extraHeaders: Record<string, string> = {},
) {
    return globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": sessionID, ...extraHeaders },
        body: JSON.stringify({ model }),
    })
}

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

test("recording filters host, method, body type, model, and session header", async (t) => {
    const { state } = setup(t)
    await globalThis.fetch("https://example.org/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude" }),
    })
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "GET",
        body: "{}",
    })
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        body: new URLSearchParams({ model: "claude" }),
    })
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "other" }),
    })
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude" }),
    })
    await realRequest()
    assert.deepEqual([...state.entries.keys()], [SESSION])
})

test("legacy v1 folder-level off does not disable per-session warming", async (t) => {
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dataHome = await mkdtemp(join(tmpdir(), "replay-warmer-v1-control-"))
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dataHome
    const directory = "/tmp/legacy-control-project"
    mkdirSync(join(dataHome, "opencode/storage/plugin/keepalive"), { recursive: true })
    writeFileSync(
        controlFilePath(directory),
        JSON.stringify({ version: 1, enabled: false, updatedAt: NOW }),
    )
    const originalFetch = globalThis.fetch
    delete (globalThis as any)[Symbol.for("opencode-cache-keepalive.replay-warmer")]
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW })
    let calls = 0
    t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls++
        if (init?.signal)
            return new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(
                            new TextEncoder().encode(
                                'data: {"type":"response.output_text.delta"}\n\n',
                            ),
                        )
                    },
                }),
            )
        return new Response("real")
    })
    const state = fakeSink()
    const engine = new ReplayWarmer(
        {},
        { ...getConfig({ enabled: true }), intervals: { gpt: 1_000 } },
        state.sink,
        new Logger(false, "/tmp/legacy.log"),
        directory,
        () => Date.now(),
    )
    engine.start()
    t.after(async () => {
        engine.dispose()
        globalThis.fetch = originalFetch
        t.mock.timers.reset()
        if (previous === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previous
        await rm(dataHome, { recursive: true, force: true })
    })
    await globalThis.fetch("https://api.githubcopilot.com/responses", {
        method: "POST",
        headers: { "X-Session-Id": "legacy-session" },
        body: JSON.stringify({ model: "gpt-5" }),
    })
    engine.onEvent({ type: "session.idle", properties: { sessionID: "legacy-session" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(state.entries.get("legacy-session")?.gapReplays, 1)
    assert.equal(calls, 2)
})

test("default config warms when the directory has no control override", async (t) => {
    const { engine, calls } = setup(t, { intervals: { claude: 1_000 } })
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(1_000)
    await flush()

    assert.equal(calls.length, 2)
})

test("record and replay outcomes reach the injected logger without request secrets", async (t) => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const directory = await mkdtemp(join(tmpdir(), "replay-warmer-log-"))
    const logger = new Logger(false, join(directory, "server.log"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const { engine } = setup(
        t,
        { intervals: { claude: 1_000 } },
        async (_input, init) => {
            if (!init?.signal) return new Response("real")
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}}\n\n',
                            ),
                        )
                    },
                }),
            )
        },
        logger,
    )

    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "logged-session", "X-Secret": SENTINEL },
        body: JSON.stringify({ model: "claude-sonnet", prompt: SENTINEL }),
    })
    engine.onEvent({ type: "session.idle", properties: { sessionID: "logged-session" } })
    t.mock.timers.tick(1_000)
    await flush()

    const log = await readFile(join(directory, "server.log"), "utf8")
    assert.match(log, /INFO \[cache-keepalive\] record api=messages host=api\.githubcopilot\.com/)
    assert.match(log, /INFO \[cache-keepalive\] replay session=logged-session .*status=200/)
    assert.equal(log.includes(SENTINEL), false)
})

test("real fetch forwards immediately and records Copilot request body later", async (t) => {
    const realResponse = Promise.resolve(new Response("real"))
    const state = fakeSink()
    let originalFetchCalled = false
    const parse = JSON.parse
    const logger = new Logger(false, "/tmp/replay-warmer-test.log")
    originalFetch = globalThis.fetch
    delete (globalThis as any)[Symbol.for("opencode-cache-keepalive.replay-warmer")]
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW })
    t.mock.method(globalThis, "fetch", () => {
        originalFetchCalled = true
        return realResponse
    })
    t.mock.method(JSON, "parse", ((
        text: string,
        reviver?: (this: any, key: string, value: any) => any,
    ) => {
        assert.equal(originalFetchCalled, true)
        return parse(text, reviver)
    }) as typeof JSON.parse)
    const engine = new ReplayWarmer(
        {},
        { ...getConfig({ enabled: true }), intervals: { claude: 60_000 } },
        state.sink,
        logger,
        "/tmp/replay-warmer-m1",
        () => Date.now(),
    )
    engine.start()
    t.after(() => {
        engine.dispose()
        globalThis.fetch = originalFetch
        t.mock.timers.reset()
    })

    const forwarded = globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": SESSION },
        body: JSON.stringify({ model: "claude-sonnet" }),
    })
    assert.equal(forwarded, realResponse)
    assert.equal(state.entries.has(SESSION), false)
    await forwarded
    await flush()
    assert.equal(state.entries.get(SESSION)?.model, "claude-sonnet")
})

test("eligible Request body is captured before a consuming transport reads it", async (t) => {
    const payload = JSON.stringify({ model: "claude-sonnet", prompt: "replay-this" })
    const realResponse = new Response("real")
    const { engine, state, calls } = setup(t, { intervals: { claude: 1_000 } }, async (input) => {
        if (input instanceof Request) await input.text()
        return realResponse
    })
    const request = new Request("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "request-capture" },
        body: payload,
    })

    const result = globalThis.fetch(request)
    assert.equal(await result, realResponse)
    assert.equal(calls[0].input, request)
    await flush()
    assert.equal(state.entries.get("request-capture")?.model, "claude-sonnet")
    engine.onEvent({ type: "session.idle", properties: { sessionID: "request-capture" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(calls.at(-1)?.init?.body, payload)
})

test("rejected cloned Request body after disposal is observed without affecting fetch", async (t) => {
    let failBody!: (error: Error) => void
    const requestBody = new ReadableStream<Uint8Array>({
        start(controller) {
            failBody = (error) => controller.error(error)
        },
    })
    const { engine } = setup(t, {}, async (input) => {
        if (input instanceof Request) void input.text().catch(() => {})
        return new Response("real")
    })
    const request = new Request("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "dispose-stream" },
        body: requestBody,
        duplex: "half",
    } as RequestInit)
    const result = globalThis.fetch(request)
    engine.dispose()
    failBody(new Error("transport body failed"))
    assert.equal((await result).status, 200)
    await flush()
})

test("unknown sessions route to the instance matching a disjoint host", async (t) => {
    originalFetch = globalThis.fetch
    delete (globalThis as any)[Symbol.for("opencode-cache-keepalive.replay-warmer")]
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        if (init?.signal)
            return new Response(
                'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":10,"cache_creation_input_tokens":0}}}\n\n',
            )
        return new Response("real")
    })
    const firstState = fakeSink()
    const secondState = fakeSink()
    const makeEngine = (
        state: ReturnType<typeof fakeSink>,
        directory: string,
        hosts: string[],
        intervals: Record<string, number>,
    ) =>
        new ReplayWarmer(
            {},
            { ...getConfig({ enabled: true }), hosts, intervals },
            state.sink,
            new Logger(false, "/tmp/routing.log"),
            directory,
            () => Date.now(),
        )
    const first = makeEngine(firstState, "/tmp/route-first", ["first.example"], { claude: 1_000 })
    const second = makeEngine(secondState, "/tmp/route-second", ["second.example"], {
        claude: 1_000,
    })
    first.start()
    second.start()
    t.after(() => {
        first.dispose()
        second.dispose()
        globalThis.fetch = originalFetch
        t.mock.timers.reset()
    })

    await globalThis.fetch("https://api.second.example/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "second-only", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet" }),
    })
    second.onEvent({ type: "session.idle", properties: { sessionID: "second-only" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(firstState.entries.has("second-only"), false)
    assert.equal(secondState.entries.get("second-only")?.gapReplays, 1)
    assert.equal(calls.at(-1)?.init?.body, JSON.stringify({ model: "claude-sonnet" }))
})

test("unknown sessions choose the matching model config when hosts overlap", async (t) => {
    originalFetch = globalThis.fetch
    delete (globalThis as any)[Symbol.for("opencode-cache-keepalive.replay-warmer")]
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        if (init?.signal)
            return new Response(
                'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":10,"cache_creation_input_tokens":0}}}\n\n',
            )
        return new Response("real")
    })
    const firstState = fakeSink()
    const secondState = fakeSink()
    const first = new ReplayWarmer(
        {},
        {
            ...getConfig({ enabled: true }),
            hosts: ["githubcopilot.com"],
            intervals: { claude: 1_000 },
        },
        firstState.sink,
        new Logger(false, "/tmp/routing-model-first.log"),
        "/tmp/routing-model-first",
        () => Date.now(),
    )
    const second = new ReplayWarmer(
        {},
        {
            ...getConfig({ enabled: true }),
            hosts: ["githubcopilot.com"],
            intervals: { gpt: 1_000 },
        },
        secondState.sink,
        new Logger(false, "/tmp/routing-model-second.log"),
        "/tmp/routing-model-second",
        () => Date.now(),
    )
    first.start()
    second.start()
    t.after(() => {
        first.dispose()
        second.dispose()
        globalThis.fetch = originalFetch
        t.mock.timers.reset()
    })
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "model-second", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5" }),
    })
    second.onEvent({ type: "session.idle", properties: { sessionID: "model-second" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(firstState.entries.has("model-second"), false)
    assert.equal(secondState.entries.get("model-second")?.gapReplays, 1)
    assert.equal(calls.at(-1)?.init?.body, JSON.stringify({ model: "gpt-5" }))
})

test("event-established ownership stays authoritative when disabled", async (t) => {
    originalFetch = globalThis.fetch
    delete (globalThis as any)[Symbol.for("opencode-cache-keepalive.replay-warmer")]
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        if (init?.signal)
            return new Response(
                'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":10,"cache_creation_input_tokens":0}}}\n\n',
            )
        return new Response("real")
    })
    const firstState = fakeSink()
    const secondState = fakeSink()
    const firstDirectory = "/tmp/authoritative-owner-first"
    const sessionID = `event-owner-${Math.random()}`
    const first = new ReplayWarmer(
        {},
        {
            ...getConfig({ enabled: true }),
            hosts: ["githubcopilot.com"],
            intervals: { claude: 1_000 },
        },
        firstState.sink,
        new Logger(false, "/tmp/owner-first.log"),
        firstDirectory,
        () => Date.now(),
    )
    const second = new ReplayWarmer(
        {},
        {
            ...getConfig({ enabled: true }),
            hosts: ["githubcopilot.com"],
            intervals: { gpt: 1_000 },
        },
        secondState.sink,
        new Logger(false, "/tmp/owner-second.log"),
        "/tmp/authoritative-owner-second",
        () => Date.now(),
    )
    first.start()
    second.start()
    first.onEvent({ type: "session.status", properties: { sessionID } })
    t.after(() => {
        first.dispose()
        second.dispose()
        globalThis.fetch = originalFetch
        t.mock.timers.reset()
    })
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": sessionID, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet" }),
    })
    await flush()
    assert.equal(firstState.entries.get(sessionID)?.model, "claude-sonnet")
    first.onEvent({ type: "session.idle", properties: { sessionID } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(firstState.entries.get(sessionID)?.gapReplays, 1)
    assert.equal(secondState.entries.has(sessionID), false)

    await setSessionEnabled(firstDirectory, sessionID, false, NOW)
    t.mock.timers.tick(1_000)
    await flush()
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": sessionID, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5" }),
    })
    assert.equal(firstState.entries.get(sessionID)?.state, "off")
    assert.equal(secondState.entries.has(sessionID), false)
    assert.equal(calls.length, 3)
})

test("Request init body string overrides Request body for replay", async (t) => {
    const payload = JSON.stringify({ model: "claude-sonnet", prompt: "override" })
    const { engine, state, calls } = setup(t, { intervals: { claude: 1_000 } })
    const request = new Request("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "request-override" },
        body: JSON.stringify({ model: "wrong-model" }),
    })
    await globalThis.fetch(request, { body: payload })
    await flush()
    engine.onEvent({ type: "session.idle", properties: { sessionID: "request-override" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(state.entries.get("request-override")?.model, "claude-sonnet")
    assert.equal(calls.at(-1)?.init?.body, payload)
})

test("ineligible Copilot request invalidates the previous replay target", async (t) => {
    const { engine, state, calls } = setup(t, { intervals: { claude: 60_000 } })
    await realRequest(SESSION, "claude-sonnet")
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    await realRequest(SESSION, "gpt-unconfigured")
    assert.equal(state.entries.get(SESSION)?.gapId, 2)
    assert.equal(state.entries.get(SESSION)?.nextReplayAt, null)
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(calls.length, 2)
})

test("ineligible request aborts an in-flight replay", async (t) => {
    let replaySignal: AbortSignal | undefined
    const { engine } = setup(t, { intervals: { claude: 1_000 } }, async (_input, init) => {
        if (init?.signal) {
            replaySignal = init.signal
            return new Promise<Response>(() => {})
        }
        return new Response("real")
    })
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(replaySignal?.aborted, false)
    await realRequest(SESSION, "gpt-unconfigured")
    assert.equal(replaySignal?.aborted, true)
})

test("assistant model switch invalidates a Copilot target from session events", async (t) => {
    const { engine, state, calls } = setup(t, { intervals: { claude: 1_000 } })
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    engine.onEvent({
        type: "message.updated",
        properties: {
            sessionID: SESSION,
            info: {
                role: "assistant",
                providerID: "openai",
                modelID: "claude-sonnet",
                time: { completed: NOW },
            },
        },
    })
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(state.entries.get(SESSION)?.nextReplayAt, null)
    assert.equal(calls.length, 1)
})

test("session disable preserves another session's replay and re-enable waits for a real request", async (t) => {
    const { engine, state, directory, calls } = setup(t, { intervals: { claude: 1_000 } })
    await setSessionEnabled(directory, "session-a", false, NOW)
    t.mock.timers.tick(1_000)
    await flush()
    await realRequest("session-a")
    await realRequest("session-b")
    engine.onEvent({ type: "session.idle", properties: { sessionID: "session-a" } })
    engine.onEvent({ type: "session.idle", properties: { sessionID: "session-b" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(state.entries.get("session-a")?.state, "off")
    assert.equal(state.entries.get("session-b")?.gapReplays, 1)
    assert.equal(calls.length, 3)

    await setSessionEnabled(directory, "session-a", true, NOW + 1)
    t.mock.timers.tick(1_000)
    assert.equal(state.entries.get("session-a")?.state, "off")
    await realRequest("session-a")
    engine.onEvent({ type: "session.idle", properties: { sessionID: "session-a" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(state.entries.get("session-a")?.gapReplays, 1)
    assert.equal(calls.length, 6)
})

test("stored byte budget evicts the least-recently-touched replay target", async (t) => {
    const { engine, state, calls } = setup(t, { intervals: { claude: 1_000 }, maxStoredBytes: 85 })
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "evicted-session" },
        body: JSON.stringify({ model: "claude", content: "first request body" }),
    })
    t.mock.timers.tick(1)
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "retained-session" },
        body: JSON.stringify({ model: "claude", content: "second request body" }),
    })
    engine.onEvent({ type: "session.idle", properties: { sessionID: "evicted-session" } })
    engine.onEvent({ type: "session.idle", properties: { sessionID: "retained-session" } })
    assert.equal(state.entries.has("evicted-session"), true)
    assert.equal(state.entries.get("evicted-session")?.nextReplayAt, null)
    assert.equal(state.entries.get("evicted-session")?.state, "idle")
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(calls.length, 3)
    assert.equal(calls.at(-1)?.init?.signal instanceof AbortSignal, true)
})

test("in-memory records without a target are pruned after sixty minutes but live targets remain", async (t) => {
    const { engine, state } = setup(t, { intervals: { claude: 10 * 60 * 60_000 } })
    await realRequest("targetless-session")
    await realRequest("targetless-session", "gpt-unconfigured")
    await realRequest("target-session")
    engine.onEvent({ type: "session.idle", properties: { sessionID: "target-session" } })
    t.mock.timers.tick(60 * 60_000 + 1_000)
    await flush()
    assert.equal(state.entries.has("targetless-session"), false)
    assert.equal(state.entries.has("target-session"), true)
})

test("rejected replay drops stored target and a later eligible request starts a fresh gap", async (t) => {
    let replayCount = 0
    const { engine, state } = setup(t, { intervals: { claude: 1_000 } }, async (_input, init) => {
        if (!init?.signal) return new Response("real")
        return ++replayCount === 1
            ? new Response("", { status: 401 })
            : new Response(
                  new ReadableStream({
                      start(controller) {
                          controller.enqueue(
                              new TextEncoder().encode(
                                  'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}}\n\n',
                              ),
                          )
                      },
                  }),
              )
    })
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(state.entries.get(SESSION)?.stopReason, "rejected-4xx")
    await realRequest()
    assert.equal(state.entries.get(SESSION)?.gapId, 2)
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(state.entries.get(SESSION)?.gapReplays, 1)
})

test("session deletion removes its display entry and releases budget for a later session", async (t) => {
    const { engine, state, calls } = setup(t, { intervals: { claude: 1_000 }, maxStoredBytes: 80 })
    await realRequest("deleted-session")
    engine.onEvent({ type: "session.deleted", properties: { sessionID: "deleted-session" } })
    assert.equal(state.entries.has("deleted-session"), false)
    await realRequest("remaining-session")
    engine.onEvent({ type: "session.idle", properties: { sessionID: "remaining-session" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(calls.length, 3)
})

test("multiple warmers retain one recorder and one replay owner per session", async (t) => {
    originalFetch = globalThis.fetch
    delete (globalThis as any)[Symbol.for("opencode-cache-keepalive.replay-warmer")]
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return new Response("ok")
    })
    const firstState = fakeSink()
    const secondState = fakeSink()
    const config = { ...getConfig({ enabled: true }), intervals: { claude: 1_000 } }
    const first = new ReplayWarmer(
        {},
        config,
        firstState.sink,
        new Logger(false, "/tmp/a.log"),
        "/tmp/a",
        () => Date.now(),
    )
    const second = new ReplayWarmer(
        {},
        config,
        secondState.sink,
        new Logger(false, "/tmp/b.log"),
        "/tmp/b",
        () => Date.now(),
    )
    first.start()
    second.start()
    second.dispose()
    t.after(() => {
        first.dispose()
        globalThis.fetch = originalFetch
        t.mock.timers.reset()
    })
    await realRequest("instance-a")
    first.onEvent({ type: "session.idle", properties: { sessionID: "instance-a" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(firstState.entries.get("instance-a")?.gapReplays, 1)
    assert.equal(calls.length, 2)
    assert.equal(secondState.entries.has("instance-a"), false)
})

test("disabling one session leaves another session in the same directory replaying", async (t) => {
    originalFetch = globalThis.fetch
    delete (globalThis as any)[Symbol.for("opencode-cache-keepalive.replay-warmer")]
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return new Response("ok")
    })
    const firstState = fakeSink()
    const secondState = fakeSink()
    const config = { ...getConfig({ enabled: true }), intervals: { claude: 1_000 } }
    const first = new ReplayWarmer(
        {},
        config,
        firstState.sink,
        new Logger(false, "/tmp/a.log"),
        "/tmp/shared-control-dir",
        () => Date.now(),
    )
    const second = new ReplayWarmer(
        {},
        config,
        secondState.sink,
        new Logger(false, "/tmp/b.log"),
        "/tmp/shared-control-dir",
        () => Date.now(),
    )
    first.start()
    second.start()
    await setSessionEnabled("/tmp/shared-control-dir", "session-a", false, NOW)
    t.mock.timers.tick(1_000)
    await flush()
    t.after(() => {
        first.dispose()
        second.dispose()
        globalThis.fetch = originalFetch
        t.mock.timers.reset()
    })
    await realRequest("session-a")
    await realRequest("session-b")
    first.onEvent({ type: "session.idle", properties: { sessionID: "session-a" } })
    first.onEvent({ type: "session.idle", properties: { sessionID: "session-b" } })
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(firstState.entries.get("session-a")?.state, "off")
    assert.equal(firstState.entries.get("session-b")?.gapReplays, 1)
    assert.equal(secondState.entries.has("session-a"), false)
    assert.equal(calls.length, 3)
})

test("title and summary generation requests are excluded by Copilot interaction header", async (t) => {
    const { state } = setup(t)
    await realRequest("title-session", "claude-sonnet", {
        "X-Interaction-Type": "agent-session-name-generation",
    })
    await realRequest("summary-session", "claude-sonnet", {
        "X-Interaction-Type": "agent-session-summary-generation",
    })
    assert.equal(state.entries.size, 0)
})

test("precise idle deadline replays exactly at lastTouch plus interval", async (t) => {
    const { engine, state, calls } = setup(t, { intervals: { claude: 60_000 } })
    await realRequest()
    engine.onEvent({
        type: "message.part.updated",
        properties: {
            part: {
                type: "step-finish",
                sessionID: SESSION,
                tokens: { input: 100, cache: { read: 0, write: 0 } },
            },
        },
    })
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(calls.length, 2)
})

test("successful replay becomes the next lastTouch deadline", async (t) => {
    const { engine, calls } = setup(t, { intervals: { claude: 60_000 } })
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(calls.length, 2)
    t.mock.timers.tick(59_999)
    await flush()
    assert.equal(calls.length, 2)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(calls.length, 3)
})

test("resume telemetry totals avoided and replay-read tokens for hit and miss gaps", async (t) => {
    const { writeFile, readFile } = await import("node:fs/promises")
    const logPath = "/tmp/replay-warmer-resume-test.log"
    await writeFile(logPath, "")
    const logger = new Logger(false, logPath)
    const { engine, state } = setup(t, { intervals: { claude: 1_000 } }, undefined, logger)
    const finish = (read: number, input: number) =>
        engine.onEvent({
            type: "message.part.updated",
            properties: {
                part: {
                    type: "step-finish",
                    sessionID: SESSION,
                    tokens: { input, cache: { read } },
                },
            },
        })

    await realRequest(SESSION, "claude-sonnet", { "X-Secret": SENTINEL })
    finish(0, 100)
    t.mock.timers.tick(1_000)
    await flush()
    await realRequest()
    finish(90, 10)
    assert.deepEqual(state.entries.get(SESSION)?.resume, {
        at: NOW + 1_000,
        read: 90,
        promptPrev: 100,
        hit: true,
        replays: 1,
        avoidedTokens: 100,
        replayReadTokens: 100,
    })
    assert.equal(state.entries.get(SESSION)?.avoidedTokens, 100)
    assert.equal(state.entries.get(SESSION)?.resumeHits, 1)
    assert.equal(state.entries.get(SESSION)?.resumeCount, 1)
    assert.deepEqual(state.totals, {
        replays: 1,
        avoidedTokens: 100,
        replayReadTokens: 100,
        resumeHits: 1,
        resumeMisses: 0,
    })

    t.mock.timers.tick(1_000)
    await flush()
    await realRequest()
    finish(89, 11)
    assert.deepEqual(state.entries.get(SESSION)?.resume, {
        at: NOW + 2_000,
        read: 89,
        promptPrev: 100,
        hit: false,
        replays: 1,
        avoidedTokens: 0,
        replayReadTokens: 100,
    })
    assert.equal(state.entries.get(SESSION)?.avoidedTokens, 100)
    assert.equal(state.entries.get(SESSION)?.resumeHits, 1)
    assert.equal(state.entries.get(SESSION)?.resumeCount, 2)
    assert.deepEqual(state.totals, {
        replays: 2,
        avoidedTokens: 100,
        replayReadTokens: 200,
        resumeHits: 1,
        resumeMisses: 1,
    })
    const log = await readFile(logPath, "utf8")
    assert.match(
        log,
        /resume session=root-session gap=3 hit=false read=89 prev=100 replays=1 avoided=0 replayRead=100/,
    )
    assert.equal(log.includes(SENTINEL), false)
})

test("precise busy deadline replays exactly at lastTouch plus interval", async (t) => {
    const { engine, calls } = setup(t, { intervals: { claude: 60_000 } })
    await realRequest()
    engine.onEvent({
        type: "message.part.updated",
        properties: {
            part: { type: "tool", sessionID: SESSION, callID: "c", state: { status: "running" } },
        },
    })
    t.mock.timers.tick(59_999)
    await flush()
    assert.equal(calls.length, 1)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(calls.length, 2)
})

test("replay-read accounting falls back to the previous prompt when usage is unavailable", async (t) => {
    const { engine, state } = setup(t, { intervals: { gpt: 1_000 } }, async (_input, init) => {
        if (!init?.signal) return new Response("real")
        return new Response('data: {"type":"response.output_text.delta"}\n\n')
    })
    await globalThis.fetch("https://api.githubcopilot.com/v1/responses", {
        method: "POST",
        headers: { "X-Session-Id": "gpt-fallback" },
        body: JSON.stringify({ model: "gpt-5" }),
    })
    engine.onEvent({
        type: "message.part.updated",
        properties: {
            part: {
                type: "step-finish",
                sessionID: "gpt-fallback",
                tokens: { input: 125, cache: { read: 0, write: 0 } },
            },
        },
    })
    t.mock.timers.tick(1_000)
    await flush()
    await globalThis.fetch("https://api.githubcopilot.com/v1/responses", {
        method: "POST",
        headers: { "X-Session-Id": "gpt-fallback" },
        body: JSON.stringify({ model: "gpt-5" }),
    })
    engine.onEvent({
        type: "message.part.updated",
        properties: {
            part: {
                type: "step-finish",
                sessionID: "gpt-fallback",
                tokens: { input: 125, cache: { read: 0, write: 0 } },
            },
        },
    })

    assert.equal(state.entries.get("gpt-fallback")?.resume?.replayReadTokens, 125)
})

test("active steps suppress replay; tool-running sessions remain eligible as busy", async (t) => {
    const { engine, state, calls } = setup(t, { intervals: { claude: 60_000 } })
    await realRequest()
    engine.onEvent({
        type: "message.part.updated",
        properties: { part: { type: "step-start", sessionID: SESSION } },
    })
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(calls.length, 1)
    engine.onEvent({
        type: "message.part.updated",
        properties: { part: { type: "step-finish", sessionID: SESSION, tokens: { input: 100 } } },
    })
    engine.onEvent({
        type: "message.part.updated",
        properties: {
            part: { type: "tool", sessionID: SESSION, callID: "c", state: { status: "running" } },
        },
    })
    assert.equal(state.entries.get(SESSION)?.state, "busy")
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(calls.length, 2)
})

test("messages abort at message_start and capture cache usage", async (t) => {
    const messages = setup(t, { intervals: { claude: 60_000 } }, async (_input, init) => {
        if (!init?.signal) return new Response("real")
        return new Response(
            new ReadableStream({
                start(c) {
                    c.enqueue(
                        new TextEncoder().encode(
                            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":12,"cache_creation_input_tokens":3}}}\n\n',
                        ),
                    )
                    c.enqueue(new TextEncoder().encode("data: never-read\n\n"))
                },
            }),
        )
    })
    await realRequest()
    messages.engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    messages.engine.onEvent({
        type: "message.part.updated",
        properties: { part: { type: "step-finish", sessionID: SESSION } },
    })
    messages.engine.onEvent({
        type: "message.part.updated",
        properties: { part: { type: "step-start", sessionID: SESSION } },
    })
    messages.engine.onEvent({
        type: "message.part.updated",
        properties: { part: { type: "step-finish", sessionID: SESSION } },
    })
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(messages.state.entries.get(SESSION)?.lastReplay?.cacheRead, 12)
    messages.engine.dispose()
})

test("Copilot GPT Responses request records /responses and skips created/in-progress events on replay", async (t) => {
    const responses = setup(t, { intervals: { gpt: 60_000 } }, async (_input, init) => {
        if (!init?.signal) return new Response("real")
        return new Response(
            new ReadableStream({
                start(c) {
                    c.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'))
                    c.enqueue(new TextEncoder().encode('data: {"type":"response.in_progress"}\n\n'))
                    c.enqueue(
                        new TextEncoder().encode('data: {"type":"response.output_text.delta"}\n\n'),
                    )
                },
            }),
        )
    })
    await globalThis.fetch("https://api.githubcopilot.com/responses", {
        method: "POST",
        headers: {
            "X-Session-Id": "gpt-session",
            "x-session-affinity": "gpt-session",
            "X-Interaction-Id": "gpt-session",
            "x-initiator": "agent",
        },
        body: JSON.stringify({ model: "gpt-6.1-sol" }),
    })
    responses.engine.onEvent({ type: "session.idle", properties: { sessionID: "gpt-session" } })
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(responses.state.entries.get("gpt-session")?.gapReplays, 1)
    const { readFile } = await import("node:fs/promises")
    const log = await readFile("/tmp/replay-warmer-test.log", "utf8")
    assert.match(log, /record api=responses host=api\.githubcopilot\.com\/responses/)
    assert.match(
        log,
        /replay session=gpt-session model=gpt-6\.1-sol api=responses gap=1 n=1\/9 status=200 latency=0ms abort=response\.output_text\.delta/,
    )
    responses.engine.dispose()
})

test("debug logs a safe reason when a Copilot request uses an unsupported path", async (t) => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const directory = await mkdtemp(join(tmpdir(), "replay-warmer-debug-"))
    const logger = new Logger(true, join(directory, "server.log"))
    const { calls } = setup(t, {}, undefined, logger)
    t.after(() => rm(directory, { recursive: true, force: true }))
    await globalThis.fetch(`https://api.githubcopilot.com/v2/responses?${SENTINEL}`, {
        method: "POST",
        headers: { "X-Session-Id": "rejected-session", "X-Secret": SENTINEL },
        body: JSON.stringify({ model: "gpt-6.1-sol" }),
    })
    await flush()

    assert.equal(calls.length, 1)
    const log = await readFile(join(directory, "server.log"), "utf8")
    assert.match(log, /DEBUG \[cache-keepalive\] record rejected reason=unsupported-path/)
    assert.equal(log.includes(SENTINEL), false)
})

test("chat replay aborts after the first chunk", async (t) => {
    const chat = setup(t, { intervals: { gpt: 60_000 } }, async (_input, init) => {
        if (!init?.signal) return new Response("real")
        return new Response(
            new ReadableStream({
                start(c) {
                    c.enqueue(new Uint8Array([1]))
                    c.enqueue(new Uint8Array([2]))
                },
            }),
        )
    })
    await globalThis.fetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { "X-Session-Id": "chat-session" },
        body: JSON.stringify({ model: "gpt" }),
    })
    chat.engine.onEvent({ type: "session.idle", properties: { sessionID: "chat-session" } })
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(chat.state.entries.get("chat-session")?.gapReplays, 1)
})

test("messages replay reporting only cache writes lapses warming", async (t) => {
    const state = setup(t, { intervals: { claude: 60_000 } }, async (_input, init) => {
        if (!init?.signal) return new Response("real")
        return new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":8}}}\n\n',
                        ),
                    )
                },
            }),
        )
    })
    await realRequest()
    state.engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(state.state.entries.get(SESSION)?.stopReason, "lapsed")
})

test("automatic replay cap stops after nine successful replays", async (t) => {
    const { engine, state } = setup(t, { intervals: { claude: 1_000 } })
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    for (let replay = 0; replay < 9; replay++) {
        t.mock.timers.tick(1_000)
        await flush()
    }
    assert.equal(state.entries.get(SESSION)?.gapReplays, 9)
    assert.equal(state.entries.get(SESSION)?.cap, 9)
    assert.equal(state.entries.get(SESSION)?.stopReason, "cap")
})

test("numeric replay cap overrides auto and stops at the configured limit", async (t) => {
    const { engine, state } = setup(t, { intervals: { claude: 1_000 }, maxReplaysPerGap: 2 })
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(1_000)
    await flush()
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(state.entries.get(SESSION)?.gapReplays, 2)
    assert.equal(state.entries.get(SESSION)?.cap, 2)
    assert.equal(state.entries.get(SESSION)?.stopReason, "cap")
})

test("known child sessions are excluded from replay tracking by default", async (t) => {
    const { engine, state } = setup(t)
    engine.onEvent({
        type: "session.created",
        properties: { info: { id: "child-session", parentID: SESSION } },
    })
    await realRequest("child-session")
    assert.equal(state.entries.has("child-session"), false)
})

test("four hundred stops warming", async (t) => {
    const rejected = setup(t, { intervals: { claude: 60_000 } }, async (_input, init) =>
        init?.signal ? new Response("", { status: 401 }) : new Response("real"),
    )
    await realRequest()
    rejected.engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(rejected.state.entries.get(SESSION)?.stopReason, "rejected-4xx")
    assert.equal(rejected.state.entries.get(SESSION)?.lastReplay?.status, 401)
    rejected.engine.dispose()
})

test("transient failure retries once after ten seconds then lapses", async (t) => {
    const transient = setup(t, { intervals: { claude: 60_000 } }, async (_input, init) =>
        init?.signal ? new Response("", { status: 500 }) : new Response("real"),
    )
    await realRequest()
    transient.engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(60_000)
    await flush()
    t.mock.timers.tick(10_000)
    await flush()
    assert.equal(transient.state.entries.get(SESSION)?.stopReason, "lapsed")
})

test("real request interrupts a replay, resets gap, and Request/non-string requests pass unchanged", async (t) => {
    let resolveReplay!: (value: Response) => void
    const { engine, state, calls } = setup(
        t,
        { intervals: { claude: 60_000 } },
        async (_input, init) => {
            if (!init?.signal) return new Response("real")
            return new Promise<Response>((resolve) => {
                resolveReplay = resolve
            })
        },
    )
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(60_000)
    await flush()
    const signal = calls[1].init?.signal as AbortSignal
    await realRequest()
    assert.equal(signal.aborted, true)
    assert.equal(state.entries.get(SESSION)?.gapId, 2)
    resolveReplay(new Response("late"))
    await flush()
    const request = new Request("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "request-object" },
        body: "{}",
    })
    await globalThis.fetch(request)
    await globalThis.fetch("https://api.githubcopilot.com/v1/messages", {
        method: "POST",
        headers: { "X-Session-Id": "form-body" },
        body: new URLSearchParams("model=claude"),
    })
    assert.equal(calls.at(-2)?.input, request)
    await globalThis.fetch(
        new Request("https://api.githubcopilot.com/v1/messages", {
            method: "POST",
            headers: { "X-Session-Id": "request-body-session" },
            body: JSON.stringify({ model: "claude-sonnet" }),
        }),
    )
    await flush()
    assert.equal(state.entries.get("request-body-session")?.model, "claude-sonnet")
    assert.equal(state.entries.get(SESSION)?.gapReplays, 0)
})

test("control disable publishes off and suppresses replays; logs exclude request secrets", async (t) => {
    const { engine, state, calls, directory } = setup(t, { intervals: { claude: 60_000 } })
    await globalThis.fetch(`https://api.githubcopilot.com/v1/messages?${SENTINEL}`, {
        method: "POST",
        headers: { "X-Session-Id": SESSION, "x-secret": SENTINEL },
        body: JSON.stringify({ model: "claude", prompt: SENTINEL }),
    })
    const { readFile } = await import("node:fs/promises")
    const logs = await readFile("/tmp/replay-warmer-test.log", "utf8").catch(() => "")
    assert.equal(logs.includes(SENTINEL), false)
    assert.equal(state.entries.get(SESSION)?.state, "active")
    assert.equal(calls.length, 1)
    await setSessionEnabled(directory, SESSION, false, NOW)
    t.mock.timers.tick(1000)
    assert.equal(state.entries.get(SESSION)?.state, "off")
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(calls.length, 1)
    engine.dispose()
})

test("disabling during an in-flight replay aborts it without counting it", async (t) => {
    let release!: (response: Response) => void
    let replaySignal: AbortSignal | undefined
    const { engine, state, directory } = setup(
        t,
        { intervals: { claude: 1_000 } },
        async (_input, init) => {
            if (!init?.signal) return new Response("real")
            replaySignal = init.signal
            return new Promise<Response>((resolve) => {
                release = resolve
            })
        },
    )
    await realRequest()
    engine.onEvent({ type: "session.idle", properties: { sessionID: SESSION } })
    t.mock.timers.tick(1_000)
    await flush()
    await setSessionEnabled(directory, SESSION, false, NOW + 1)
    t.mock.timers.tick(1_000)
    await flush()
    assert.equal(replaySignal?.aborted, true)
    assert.equal(state.entries.get(SESSION)?.sessionReplays, 0)
    release(new Response("ignored"))
})
