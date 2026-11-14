import test from "node:test"
import assert from "node:assert/strict"
import { onRequest } from "../poxian.hooks.mjs"
import { sessionKey } from "../src/policy.mjs"
import * as latch from "../src/latch.mjs"
import { MARK } from "../src/constants.mjs"

const body = () => ({
  model: "group/dp4.1f",
  messages: [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "答" },
    { role: "user", content: "第二问" },
  ],
})

const ctx = (options) => ({ agent: "claude", model: "group/dp4.1f", protocol: "chat", cwd: "/tmp", options })

const base = { log: false, gatewayTimeoutMs: 500, prompt: "fujiang-lite", inject_mode: "on_refusal" }

const systemText = (b) => {
  const m = (b.messages || []).find((x) => x.role === "system" || x.role === "developer")
  return m ? String(m.content) : ""
}

test("on_refusal: 无锁存 → 一个字节都不改", async () => {
  latch.reset()
  const b = body()
  const out = await onRequest(b, ctx(base))
  assert.equal(out, undefined)
})

test("on_refusal: 锁存命中 → 注入，且删掉历史里的拒答轮", async () => {
  latch.reset()
  const b = body()
  b.messages.splice(2, 0, { role: "assistant", content: "抱歉，我无法协助这个请求。" })
  const c = ctx(base)
  latch.arm(sessionKey(b, c), 300000)
  const out = await onRequest(b, c)
  assert.ok(out, "应当返回改写后的 body")
  assert.ok(systemText(out).includes(MARK), "注入内容必须带幂等标记")
  assert.equal(
    (out.messages || []).some((m) => String(m.content).includes("无法协助")),
    false,
    "锁存命中时拒答历史必须清掉，否则模型照着自己上一句再拒一遍",
  )
})

test("always: 首轮就注入，不受锁存影响", async () => {
  latch.reset()
  const out = await onRequest(body(), ctx({ ...base, inject_mode: "always" }))
  assert.ok(out && systemText(out).includes(MARK))
})

test("幂等: 已带标记的 body 过第二次不会叠加", async () => {
  latch.reset()
  const once = await onRequest(body(), ctx({ ...base, inject_mode: "always" }))
  const twice = await onRequest(once, ctx({ ...base, inject_mode: "always" }))
  assert.equal(twice, undefined, "第二次应当识别标记后放行")
  assert.equal(String(once.messages[0].content).split(MARK).length - 1, 1)
})
