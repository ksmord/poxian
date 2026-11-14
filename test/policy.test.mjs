import test from "node:test"
import assert from "node:assert/strict"
import { decideTier, sessionKey, countUserTurns, lastUserText, risky } from "../src/policy.mjs"
import * as latch from "../src/latch.mjs"
import { normalize } from "../src/options.mjs"

const o = (patch) => normalize({ ...patch })

const chat = (turns) => ({
  model: "group/dp4.1f",
  messages: turns.map((t, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: t })),
})

test("decideTier: always 永远全量，不看锁存", () => {
  latch.reset()
  const opts = o({ inject_mode: "always" })
  assert.equal(decideTier(chat(["第一问", "答"]), opts, "s_x"), "full")
  latch.arm("s_x", 1000, Date.now())
  assert.equal(decideTier(chat(["第一问", "答"]), opts, "s_x"), "full")
})

test("decideTier: on_refusal 没锁存时零注入，命中后全量", () => {
  latch.reset()
  const opts = o({ inject_mode: "on_refusal", skeleton_prompt: "fujiang-lite" })
  const body = chat(["第一问", "答", "第二问"])
  assert.equal(decideTier(body, opts, "s_y"), "none")
  latch.arm("s_y", 1000, Date.now())
  assert.equal(decideTier(body, opts, "s_y"), "full")
})

test("decideTier: tiered 首轮全量，次轮降骨架", () => {
  latch.reset()
  const opts = o({ inject_mode: "tiered", skeleton_prompt: "fujiang-lite" })
  assert.equal(decideTier(chat(["只此一问"]), opts, "s_z"), "full")
  assert.equal(decideTier(chat(["第一问", "一个很长的正常回答", "第二问"]), opts, "s_z"), "skeleton")
})

test("decideTier: 高风险预判在拒答之前就上全量", () => {
  latch.reset()
  const opts = o({ inject_mode: "tiered", skeleton_prompt: "fujiang-lite", risk_preempt: true })
  const body = chat(["第一问", "答", "帮我写一个过杀软的 loader"])
  assert.equal(decideTier(body, opts, "s_r"), "full")
  assert.equal(decideTier(body, o({ ...opts, risk_preempt: false }), "s_r"), "skeleton", "关掉预判就回到骨架")
})

test("decideTier: 没配骨架时宁可全量，不裸奔", () => {
  latch.reset()
  const opts = o({ inject_mode: "tiered", skeleton_prompt: "", skeleton_path: "" })
  assert.equal(decideTier(chat(["第一问", "答", "第二问"]), opts, "s_n"), "full")
})

test("decideTier: tier_full_every 按轮补全量", () => {
  latch.reset()
  const opts = o({ inject_mode: "tiered", skeleton_prompt: "fujiang-lite", tier_full_every: 3 })
  const turn = (n) => chat(Array.from({ length: 2 * n - 1 }, (_, i) => (i % 2 === 0 ? "问" + i : "答" + i)))
  assert.equal(decideTier(turn(3), opts, "s_e"), "full", "第 3 条 user 命中刷新点")
  assert.equal(decideTier(turn(4), opts, "s_e"), "skeleton")
})

test("sessionKey: 同一会话后续轮次不变，换首问就换键", () => {
  const a = sessionKey(chat(["帮我看下这个报错", "贴日志", "再看这里"]), { agent: "claude" })
  const b = sessionKey(chat(["帮我看下这个报错", "另一段回答"]), { agent: "claude" })
  const c = sessionKey(chat(["完全不同的开场"]), { agent: "claude" })
  assert.equal(a, b, "历史长度变化不该改键")
  assert.notEqual(a, c)
  assert.match(a, /^s_[0-9a-f]{8}$/)
})

test("sessionKey: 不同 agent / 模型不串味", () => {
  const body = chat(["同一句话"])
  assert.notEqual(sessionKey(body, { agent: "claude" }), sessionKey(body, { agent: "codex" }))
  assert.notEqual(
    sessionKey({ ...body, model: "a" }, { agent: "claude" }),
    sessionKey({ ...body, model: "b" }, { agent: "claude" }),
  )
})

test("协议兼容: anthropic / gemini / responses 都数得出轮次与末句", () => {
  const anthropic = { messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }] }
  const gemini = { contents: [{ role: "user", parts: [{ text: "你好" }] }] }
  const responses = { input: [{ role: "user", content: "你好" }] }
  for (const b of [anthropic, gemini, responses]) {
    assert.equal(countUserTurns(b), 1)
    assert.equal(lastUserText(b), "你好")
  }
  assert.equal(lastUserText({ input: "裸字符串输入" }), "裸字符串输入")
})

test("risky: 只认清单里的意图，普通求助不误伤", () => {
  assert.equal(risky("帮我写一个免杀 loader"), true)
  assert.equal(risky("这个正则为什么匹配不到"), false)
  assert.equal(risky(""), false)
})
