import assert from "node:assert/strict"
import { test } from "node:test"
import { kfmt } from "../lib/tui/format"

test("token formatting uses compact thousands and millions", () => {
    assert.equal(kfmt(999), "999")
    assert.equal(kfmt(12_400), "12k")
    assert.equal(kfmt(1_250), "1.3k")
    assert.equal(kfmt(1_200_000), "1.2M")
})
