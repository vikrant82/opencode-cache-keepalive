import assert from "node:assert/strict"
import { test } from "node:test"
import { getConfig } from "../lib/config"

test("replay config exposes design defaults and interval overrides", () => {
    const config = getConfig({ intervals: { Claude: 123_000, GPT: 456_000 } })
    assert.deepEqual(config.intervals, { claude: 123_000, gpt: 456_000 })
    assert.deepEqual(config.hosts, ["githubcopilot.com"])
    assert.equal(config.enabled, true)
    assert.equal(config.cacheReadFactor, 0.1)
    assert.equal(config.missFactor, 1)
    assert.equal(config.maxReplaysPerGap, "auto")
    assert.equal(config.replayTimeoutMs, 60_000)
    assert.equal(config.maxStoredBytes, 67_108_864)
})

test("stored request byte budget accepts option and environment overrides", () => {
    assert.equal(getConfig({ maxStoredBytes: 1234 }).maxStoredBytes, 1234)
    const previous = process.env.OPENCODE_KEEPALIVE_MAX_STORED_BYTES
    process.env.OPENCODE_KEEPALIVE_MAX_STORED_BYTES = "2345"
    try {
        assert.equal(getConfig({}).maxStoredBytes, 2345)
    } finally {
        if (previous === undefined) delete process.env.OPENCODE_KEEPALIVE_MAX_STORED_BYTES
        else process.env.OPENCODE_KEEPALIVE_MAX_STORED_BYTES = previous
    }
})

test("deprecated ping and busy-warm options warn once and are ignored", () => {
    const warnings: string[] = []
    const config = getConfig(
        { intervalMs: 1, pingToken: "secret", claudeBusyWarm: true },
        (warning) => warnings.push(warning),
    )
    assert.equal(config.intervals.claude, 285_000)
    assert.equal(warnings.length, 3)
    assert.deepEqual(new Set(warnings).size, 3)
    getConfig({ intervalMs: 2 }, (warning) => warnings.push(warning))
    assert.equal(warnings.length, 3)
})
