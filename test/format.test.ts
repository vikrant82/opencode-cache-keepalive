import assert from "node:assert/strict"
import { test } from "node:test"
import { formatDuration, parseDuration } from "../lib/tui/format"

test("parseDuration accepts supported duration formats", () => {
    for (const [input, expected] of [
        ["4m30s", 270_000],
        ["4.5m", 270_000],
        ["270s", 270_000],
        ["28m 20s", 1_700_000],
        ["1h", 3_600_000],
        ["30", 1_800_000],
        ["90 sec", 90_000],
    ] as const) {
        assert.equal(parseDuration(input), expected, input)
    }
})

test("parseDuration rejects malformed durations", () => {
    for (const input of ["", "abc", "5x", "m5"]) {
        assert.equal(parseDuration(input), undefined, input)
    }
})

test("formatDuration renders interval labels compactly", () => {
    assert.equal(formatDuration(270_000), "4m 30s")
    assert.equal(formatDuration(1_700_000), "28m 20s")
    assert.equal(formatDuration(3_600_000), "1h")
    assert.equal(formatDuration(60_000), "1m")
})
