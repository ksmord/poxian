// Standalone runner for cases.json — same calling convention as magpie's
// gateway (fresh body copy per case, ctx.protocol default anthropic, a
// middleware returning undefined leaves the request untouched). No
// dependencies: `node poxian.test.mjs`.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import * as mod from "./poxian.middleware.js"

const dir = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))

let failed = 0
for (const c of cases) {
  let rejected
  const ctx = {
    protocol: "anthropic", model: "", stream: false, path: "", ...c.ctx,
    options: c.options ?? {}, state: {},
    reject(status, message) { rejected ??= { status, message } },
  }
  const copy = (v) => JSON.parse(JSON.stringify(v))
  try {
    const out = mod.onRequest(copy(c.request), ctx)
    if (rejected) throw new Error("unexpected reject: " + JSON.stringify(rejected))
    const actual = out === undefined ? c.request : out
    if (c.expect_marker) {
      const s = JSON.stringify(actual)
      assert.ok(s.includes(c.expect_marker), "marker missing: " + c.expect_marker)
      continue
    }
    const expected = c.expect_request ?? c.request
    // __startsWith: 前缀断言（握手 prompt 全文太长，只断言开头）
    for (const [i, m] of (expected.messages ?? []).entries()) {
      if (m && m.content && typeof m.content === "object" && m.content.__startsWith) {
        assert.equal(typeof actual.messages[i].content, "string")
        assert.ok(actual.messages[i].content.startsWith(m.content.__startsWith), "message[" + i + "] prefix mismatch")
        m.content = actual.messages[i].content
      }
    }
    assert.deepEqual(actual, copy(expected))
    console.log("  ok  " + c.name)
  } catch (e) {
    failed++
    console.log("FAIL  " + c.name + "\n      " + e.message.split("\n").slice(0, 6).join("\n      "))
  }
}
console.log(failed === 0 ? `\n${cases.length}/${cases.length} cases passed` : `\n${failed}/${cases.length} cases FAILED`)
process.exit(failed === 0 ? 0 : 1)
