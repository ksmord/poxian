// 探针回显的落点测试：钉死「回显不能进 system」这条约束。
//
// 背景（实机数据，2026-11-12）：
//   回显指令追加在注入载荷末尾 → 载荷被 prepend 到 system → 每请求换一个 nonce。
//   上游前缀缓存逐 token 比对，于是 nonce 之前的 ~1024 token 命中，
//   nonce 之后（= 整段对话历史）全部按新 token 计费。
//   后果：workbuddy 路由 79.4% → 1.3%，1206 次调用里 1066 次 cache_read 恰好 = 1024。
// 所以这里不测「nonce 有没有进请求体」（那是 probe-wiring 的事），
// 只测「system 前缀有没有被 nonce 污染」。

import test from "node:test"
import assert from "node:assert/strict"

import { normalize } from "../src/options.mjs"
import { handle } from "../src/core.mjs"
import { MARK, HANDSHAKE_TEXT } from "../src/constants.mjs"

const TEXT = MARK + "\nPROMPT-BODY"
const PAYLOAD = { text: TEXT, handshake: MARK + "\n" + HANDSHAKE_TEXT }

function run(body, protocol, opts, ctxState) {
  const ctx = { protocol, state: ctxState }
  return handle(body, ctx, PAYLOAD, normalize(opts))
}

// 取各协议的 system 落点，用来做字节级比对
function systemOf(protocol, body) {
  if (protocol === "anthropic") return JSON.stringify(body.system ?? null)
  if (protocol === "responses") return JSON.stringify(body.instructions ?? null)
  if (protocol === "gemini") return JSON.stringify(body.systemInstruction ?? null)
  const m = (body.messages || []).find((x) => x && (x.role === "system" || x.role === "developer"))
  return JSON.stringify(m ? m.content : null)
}

const CASES = [
  {
    protocol: "chat",
    body: () => ({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    tailOf: (b) => b.messages[b.messages.length - 1],
  },
  {
    protocol: "anthropic",
    body: () => ({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    tailOf: (b) => b.messages[b.messages.length - 1],
  },
  {
    protocol: "responses",
    body: () => ({ model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
    tailOf: (b) => b.input[b.input.length - 1],
  },
  {
    protocol: "gemini",
    body: () => ({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    tailOf: (b) => b.contents[b.contents.length - 1],
  },
]

for (const c of CASES) {
  test(`${c.protocol}：回显落在最后一条 user 消息，不进 system`, () => {
    const body = c.body()
    const st = {}
    run(body, c.protocol, { probe_echo: true }, st)
    const nonce = st.probeNonce
    assert.match(nonce, /^[A-HJ-NP-Z2-9]{6}$/)
    assert.ok(JSON.stringify(c.tailOf(body)).includes(`[PX-${nonce}]`))
    assert.equal(systemOf(c.protocol, body).includes("[PX-"), false)
  })

  test(`${c.protocol}：两次请求的 system 字节完全相同（前缀可缓存）`, () => {
    const a = c.body()
    const b = c.body()
    run(a, c.protocol, { probe_echo: true }, {})
    run(b, c.protocol, { probe_echo: true }, {})
    assert.equal(systemOf(c.protocol, a), systemOf(c.protocol, b))
  })

  test(`${c.protocol}：probe_echo_position=payload 可回退旧行为`, () => {
    const body = c.body()
    const st = {}
    run(body, c.protocol, { probe_echo: true, probe_echo_position: "payload" }, st)
    assert.ok(systemOf(c.protocol, body).includes(`[PX-${st.probeNonce}]`))
  })
}

test("没有 user 消息时补一条，不丢探针", () => {
  const body = { model: "m", messages: [{ role: "assistant", content: "old" }] }
  const st = {}
  run(body, "chat", { probe_echo: true, override_mode: "merge" }, st)
  const last = body.messages[body.messages.length - 1]
  assert.equal(last.role, "user")
  assert.ok(String(last.content).includes(`[PX-${st.probeNonce}]`))
})

test("probe_echo 关：system 与 user 都不带标记", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] }
  const st = {}
  run(body, "chat", { probe_echo: false }, st)
  assert.equal(JSON.stringify(body).includes("[PX-"), false)
  assert.equal(st.probeNonce, undefined)
})

test("默认值：probe_echo_position 归一为 message", () => {
  assert.equal(normalize({}).probe_echo_position, "message")
  assert.equal(normalize({ probe_echo_position: "payload" }).probe_echo_position, "payload")
  assert.equal(normalize({ probe_echo_position: "xxx" }).probe_echo_position, "message")
})
