// 探针与核心的接线测试：验的是「nonce 真的进了请求体」「nonce 真的传到了 onResponse」。
// 纯函数层的判定已在 probe.test.mjs 覆盖，这里只钉接线处——那是唯一会静默断掉的地方。

import test from "node:test"
import assert from "node:assert/strict"

import { normalize } from "../src/options.mjs"
import { handle } from "../src/core.mjs"
import { MARK, HANDSHAKE_TEXT } from "../src/constants.mjs"

const TEXT = MARK + "\nPROMPT-BODY"

function run(body, ctx, opts) {
  const o = normalize(opts)
  return handle(body, ctx, { text: TEXT, handshake: MARK + "\n" + HANDSHAKE_TEXT }, o)
}

test("probe_echo 关：请求体里没有 PX 标记，ctx.state 不写 nonce", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] }
  const ctx = { protocol: "chat", state: {} }
  run(body, ctx, { probe_echo: false })
  const sys = body.messages[0].content
  assert.ok(sys.includes("PROMPT-BODY"))
  assert.equal(sys.includes("[PX-"), false)
  assert.equal(ctx.state.probeNonce, undefined)
})

test("probe_echo 开：标记进请求体，nonce 落到 ctx.state", () => {
  const body = { model: "m", messages: [{ role: "system", content: "OWN" }, { role: "user", content: "hi" }] }
  const ctx = { protocol: "chat", state: {} }
  run(body, ctx, { probe_echo: true })
  const sys = body.messages[0].content
  const last = body.messages[body.messages.length - 1]
  assert.match(ctx.state.probeNonce, /^[A-HJ-NP-Z2-9]{6}$/)
  // 默认落点：最后一条 user 消息，不碰 system
  assert.ok(String(last.content).includes("[PX-" + ctx.state.probeNonce + "]"))
  assert.equal(String(sys).includes("[PX-"), false)
  assert.ok(String(sys).includes("PROMPT-BODY"))
})

test("probe_echo 开：每次请求 nonce 不同（防止上游缓存/复读冒充命中）", () => {
  const seen = new Set()
  for (let i = 0; i < 8; i++) {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] }
    const ctx = { protocol: "chat", state: {} }
    run(body, ctx, { probe_echo: true })
    seen.add(ctx.state.probeNonce)
  }
  assert.equal(seen.size, 8)
})

test("probe_echo 开：replace 模式同样带上探针", () => {
  const body = { system: "OWN-SYSTEM", messages: [{ role: "user", content: "hi" }] }
  const ctx = { protocol: "anthropic", state: {} }
  const r = run(body, ctx, { probe_echo: true, override_mode: "replace" })
  assert.equal(r.action, "inject")
  assert.equal(String(body.system).includes("[PX-"), false)
  assert.equal(String(body.system).includes("OWN-SYSTEM"), false)
  const last = body.messages[body.messages.length - 1]
  assert.ok(JSON.stringify(last.content).includes("[PX-" + ctx.state.probeNonce + "]"))
})

test("probe_echo 开：ctx 没有 state 时不炸（同步中间件壳的旧路径）", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] }
  const ctx = { protocol: "chat" } // 无 state
  const r = run(body, ctx, { probe_echo: true })
  assert.equal(r.action, "inject") // 不抛错，只是没地方存 nonce
})

test("probe_echo 开：skip-mark 时不留 nonce（该请求根本没注入）", () => {
  const body = {
    model: "m",
    messages: [{ role: "system", content: TEXT }, { role: "user", content: "hi" }],
  }
  const ctx = { protocol: "chat", state: {} }
  const r = run(body, ctx, { probe_echo: true })
  assert.equal(r.action, "skip-mark")
  assert.equal(ctx.state.probeNonce, undefined)
})
