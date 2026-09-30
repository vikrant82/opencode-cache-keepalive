import assert from "node:assert/strict"
import { test } from "node:test"
import { formatDetails, formatStatusLine } from "../lib/tui/footer"
import type { SessionWarmEntry } from "../lib/types"
import { notifyRejectedReplayOnce } from "../tui"
import { registerKeepaliveCommands } from "../lib/tui/commands"

test("footer status lines describe each keepalive lifecycle state", () => {
    const base = entry()
    assert.equal(
        formatStatusLine({ ...base, state: "active" }, 0),
        "keepalive standby · model working",
    )
    assert.equal(
        formatStatusLine({ ...base, state: "idle", gapReplays: 0 }, 61_000),
        "keepalive idle · 0/9 · next 1:01",
    )
    assert.equal(
        formatStatusLine({ ...base, state: "busy", gapReplays: 0 }, 61_000),
        "keepalive busy · 0/9 · next 1:01",
    )
    assert.equal(formatStatusLine(base, 5_000), "keepalive idle · 2/9 · next 0:05")
    assert.equal(
        formatStatusLine({ ...base, state: "busy", nextReplayAt: null }, 0),
        "keepalive busy · 2/9",
    )
    assert.equal(
        formatStatusLine({ ...base, state: "stopped", stopReason: "cap" }, 0),
        "keepalive stopped · refresh cap (9)",
    )
    assert.equal(
        formatStatusLine({ ...base, state: "stopped", stopReason: "lapsed" }, 0),
        "keepalive stopped · cache expired",
    )
    assert.equal(
        formatStatusLine(
            { ...base, state: "stopped", stopReason: "rejected-4xx", stopStatus: 403 },
            0,
        ),
        "keepalive stopped · refresh rejected 403",
    )
    assert.equal(
        formatStatusLine({ ...base, state: "stopped", stopReason: "disabled" }, 0),
        "keepalive off",
    )
    assert.equal(formatStatusLine({ ...base, state: "off" }, 0), "keepalive off")
})

test("footer details always show refreshes, resume ratio, and gross savings", () => {
    const base = entry()
    assert.equal(
        formatDetails({ ...base, sessionReplays: 0 }),
        "refreshes 0 · hits 0/0 · saved ~0 tok",
    )
    assert.equal(
        formatDetails({ ...base, resumeCount: 0, avoidedTokens: 12_400 }),
        "refreshes 2 · hits 0/0 · saved ~12k tok",
    )
    assert.equal(
        formatDetails({ ...base, avoidedTokens: 1_250, resumeHits: 2, resumeCount: 3 }),
        "refreshes 2 · hits 2/3 · saved ~1.3k tok",
    )
    assert.equal(
        formatDetails({ ...base, avoidedTokens: 1_200_000 }),
        "refreshes 2 · hits 0/0 · saved ~1.2M tok",
    )
    assert.equal(
        formatDetails({ ...base, avoidedTokens: 0 }),
        "refreshes 2 · hits 0/0 · saved ~0 tok",
    )
    assert.equal(
        formatDetails({ ...base, avoidedTokens: 0, resumeHits: 1, resumeCount: 1 }),
        "refreshes 2 · hits 1/1 · saved ~0 tok",
    )
})

test("rejected refresh toast deduplicates per session and gap", () => {
    const notified = new Set<string>()
    const messages: string[] = []
    const rejected = {
        ...entry(),
        state: "stopped" as const,
        stopReason: "rejected-4xx" as const,
        stopStatus: 403,
    }
    notifyRejectedReplayOnce(notified, "a", rejected, (message) => messages.push(message))
    notifyRejectedReplayOnce(notified, "a", rejected, (message) => messages.push(message))
    notifyRejectedReplayOnce(notified, "b", rejected, (message) => messages.push(message))
    notifyRejectedReplayOnce(notified, "a", { ...rejected, gapId: 8 }, (message) =>
        messages.push(message),
    )
    assert.deepEqual(messages, [
        "Keepalive refresh rejected (403) — stopped for this session",
        "Keepalive refresh rejected (403) — stopped for this session",
        "Keepalive refresh rejected (403) — stopped for this session",
    ])
})

test("toggle command without an open session only displays guidance", async (t) => {
    let commands: Array<{ slashName: string; run: (input?: unknown) => unknown }> = []
    const messages: string[] = []
    const api = {
        state: { path: { directory: "/tmp/no-session-control" } },
        route: { current: { name: "home" } },
        keymap: {
            registerLayer: (layer: {
                commands: Array<{ slashName: string; run: (input?: unknown) => unknown }>
            }) => (commands = layer.commands),
        },
        ui: { toast: (toast: { message: string }) => messages.push(toast.message) },
    }
    registerKeepaliveCommands(api as any)
    await commands.find((command) => command.slashName === "keepalive-off")?.run()

    assert.deepEqual(messages, ["Open a session to toggle keepalive"])
})

function entry(): SessionWarmEntry {
    return {
        sessionID: "session",
        updatedAt: 1_700_000_000_000,
        enabled: true,
        model: "claude-test",
        api: "messages",
        state: "idle",
        gapId: 7,
        gapReplays: 2,
        cap: 9,
        nextReplayAt: 1_700_000_285_000,
        sessionReplays: 2,
        avoidedTokens: 0,
        resumeHits: 0,
        resumeCount: 0,
    }
}
