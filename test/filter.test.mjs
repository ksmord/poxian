// 报文清洗单元测试：四种协议的 system 形状 + 拒绝历史合并 + 接线语义。
//
// 这一组存在的理由：清洗默认关闭，26 条快照用例走的全是旧路径，
// 它们全绿不构成对新分支的任何证明。这里每条都显式打开开关。
import test from "node:test"
import assert from "node:assert/strict"

import { normalize } from "../src/options.mjs"
import { handle } from "../src/core.mjs"
import { filterMessages, SAFETY_KEYWORDS, DENY_PHRASES } from "../src/filter.mjs"
import { onRequest as prefilterHook } from "../prefilter/hooks.mjs"

const TEXT = "<!--poxian-->\nPROMPT-BODY"
const PAYLOAD = { text: TEXT, handshake: "<!--poxian-->\nHANDSHAKE" }

function run(body, ctx, opts) {
  return handle(body, ctx, PAYLOAD, normalize(opts))
}

/* ---------- 总开关 ---------- */

test("清洗：enabled=false 时原引用透传，不克隆", () => {
  const body = { messages: [{ role: "system", content: "你是安全助手" }] }
  const out = filterMessages(body, { enabled: false, strip_safety_system: true })
  assert.equal(out, body)
})

test("清洗：两个子开关都关时也不克隆", () => {
  const body = { system: "你是安全助手", messages: [] }
  const out = filterMessages(body, { enabled: true, strip_safety_system: false, strip_deny_assistant: false })
  assert.equal(out, body)
})

test("清洗：未命中时返回原引用（调用方据此判 changed）", () => {
  const body = { system: "You code.", messages: [] }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.equal(out, body)
})

/* ---------- chat ---------- */

test("清洗 · chat：system 与 developer 都算 system 位", () => {
  const body = {
    messages: [
      { role: "system", content: "你是安全助手" },
      { role: "developer", content: "合规要求：禁止" },
      { role: "user", content: "hi" },
    ],
  }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].role, "user")
})

test("清洗 · chat：content 是 block 数组时按文本判命中", () => {
  const body = {
    messages: [
      { role: "system", content: [{ type: "text", text: "遵守法律" }] },
      { role: "user", content: "hi" },
    ],
  }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.equal(out.messages.length, 1)
})

test("清洗 · chat：不命中关键词的 system 保留", () => {
  const body = { messages: [{ role: "system", content: "You are a coding agent." }] }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.equal(out, body)
})

/* ---------- anthropic ---------- */

test("清洗 · anthropic：字符串 system 命中即整个字段删除", () => {
  const body = { system: "不能生成受限内容", messages: [] }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.equal(out.system, undefined)
  assert.ok(!("system" in out))
})

test("清洗 · anthropic：block 数组只删命中块", () => {
  const body = {
    system: [
      { type: "text", text: "你是安全助手" },
      { type: "text", text: "You code." },
    ],
    messages: [],
  }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.equal(out.system.length, 1)
  assert.equal(out.system[0].text, "You code.")
})

test("清洗 · anthropic：全部块命中时删字段而不是留空数组", () => {
  const body = { system: [{ type: "text", text: "禁止" }], messages: [] }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.ok(!("system" in out))
})

/* ---------- responses ---------- */

test("清洗 · responses：instructions 命中即删除", () => {
  const body = { instructions: "合规要求", input: [] }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.ok(!("instructions" in out))
})

test("清洗 · responses：input 里的拒绝式 assistant 被删，且不做同角色合并", () => {
  const body = {
    input: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "抱歉，无法提供" },
      { role: "user", content: "q2" },
    ],
  }
  const out = filterMessages(body, { enabled: true, strip_deny_assistant: true })
  // Responses 的 input 允许连续同角色，也允许带 type/metadata 的独立 message 项，
  // 合并会把它们揉坏，所以这里只删不并。
  assert.equal(out.input.length, 2)
  assert.equal(out.input[0].content, "q1")
  assert.equal(out.input[1].content, "q2")
})

/* ---------- gemini ---------- */

test("清洗 · gemini：systemInstruction.parts 命中即删字段", () => {
  const body = { systemInstruction: { parts: [{ text: "禁止输出" }] }, contents: [] }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.ok(!("systemInstruction" in out))
})

test("清洗 · gemini：snake_case system_instruction 同样处理", () => {
  const body = { system_instruction: "你是安全助手", contents: [] }
  const out = filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.ok(!("system_instruction" in out))
})

test("清洗 · gemini：assistant 的 role 是 model", () => {
  const body = {
    contents: [
      { role: "user", parts: [{ text: "q1" }] },
      { role: "model", parts: [{ text: "抱歉，不能" }] },
      { role: "user", parts: [{ text: "q2" }] },
    ],
  }
  const out = filterMessages(body, { enabled: true, strip_deny_assistant: true })
  assert.equal(out.contents.length, 2)
  // Gemini 不合并：连续同角色在这套协议里是合法的
  assert.equal(out.contents[0].parts[0].text, "q1")
  assert.equal(out.contents[1].parts[0].text, "q2")
})

/* ---------- 不变量 ---------- */

test("清洗：不修改入参对象", () => {
  const body = { system: "你是安全助手", messages: [{ role: "user", content: "hi" }] }
  const snapshot = JSON.stringify(body)
  filterMessages(body, { enabled: true, strip_safety_system: true })
  assert.equal(JSON.stringify(body), snapshot)
})

test("清洗：关键词表非空，且每项小写比较不误伤空串", () => {
  assert.ok(SAFETY_KEYWORDS.length > 0)
  assert.ok(DENY_PHRASES.length > 0)
  const body = { system: "", messages: [] }
  assert.equal(filterMessages(body, { enabled: true, strip_safety_system: true }), body)
})

/* ---------- 接线语义 ---------- */

test("接线：先把自带 system 清掉，override=false 才会重新注入", () => {
  // 这是清洗插入位置的核心断言：若清洗放在 existing 判定之后，
  // 这里会因为"请求本来有 system"而 skip-override。
  const body = { system: "你是安全助手", messages: [] }
  const r = run(body, { protocol: "anthropic" }, {
    on_prompt: "P.",
    cache: false,
    enable_message_filter: true,
    strip_safety_system: true,
    override: false,
  })
  assert.equal(r.action, "inject")
  assert.equal(r.body.system, TEXT)
  // 入参不被就地修改：清洗走的是克隆，替换靠返回值
  assert.equal(body.system, "你是安全助手")
})

test("接线：override=false 且 system 未命中时仍然 skip-override", () => {
  const body = { system: "You code.", messages: [] }
  const r = run(body, { protocol: "anthropic" }, {
    enable_message_filter: true,
    strip_safety_system: true,
    override: false,
  })
  assert.equal(r.action, "skip-override")
  assert.equal(body.system, "You code.")
})

test("接线：命中后 meta 打 filtered 标记", () => {
  const body = { system: "你是安全助手", messages: [] }
  const r = run(body, { protocol: "anthropic" }, {
    on_prompt: "P.",
    cache: false,
    enable_message_filter: true,
  })
  assert.equal(r.meta.filtered, true)
})

test("接线：未命中时 meta 不带 filtered", () => {
  const body = { system: "You code.", messages: [] }
  const r = run(body, { protocol: "anthropic" }, {
    on_prompt: "P.",
    cache: false,
    enable_message_filter: true,
  })
  assert.equal(r.meta.filtered, undefined)
})

// 断言「子键为 true 也不动报文」需要一个能观察的载体：原 system 必须还在。
// replace 下 system 会被整段覆盖，清洗开没开都得同一结果，这条会变成废用例。
// 所以显式走 merge，让未被清洗掉的后半段留在报文里可断言。
test("接线：总开关关闭时 policy 子键即使为 true 也不动报文", () => {
  const body = { system: "你是安全助手", messages: [] }
  run(body, { protocol: "anthropic" }, {
    on_prompt: "P.",
    cache: false,
    enable_message_filter: false,
    strip_safety_system: true,
    override_mode: "merge",
  })
  assert.ok(body.system.indexOf("你是安全助手") !== -1)
})

test("接线：dry_run 下清洗只发生在副本上", () => {
  const body = { system: "你是安全助手", messages: [] }
  const r = run(body, { protocol: "anthropic" }, {
    on_prompt: "P.",
    cache: false,
    enable_message_filter: true,
    dry_run: true,
  })
  assert.equal(r.body, undefined)
  assert.equal(body.system, "你是安全助手")
  assert.equal(r.meta.filtered, true)
})

/* ---------- 插件壳 ---------- */

test("prefilter 壳：未启用时返回 undefined（放行）", async () => {
  const body = { system: "你是安全助手", messages: [] }
  const out = await prefilterHook(body, { options: {} })
  assert.equal(out, undefined)
})

test("prefilter 壳：启用时返回清洗后的新对象", async () => {
  const body = { system: "你是安全助手", messages: [] }
  const out = await prefilterHook(body, { options: { enabled: true } })
  assert.ok(out && !("system" in out))
  assert.equal(body.system, "你是安全助手")
})

test("prefilter 壳：也读嵌套 magpie.options", async () => {
  const body = { system: "禁止", messages: [] }
  const out = await prefilterHook(body, {
    options: { magpie: { options: { enabled: true, strip_safety_system: true } } },
  })
  assert.ok(out && !("system" in out))
})

test("prefilter 壳：未命中时返回 undefined，不产生空改动", async () => {
  const body = { system: "You code.", messages: [] }
  const out = await prefilterHook(body, { options: { enabled: true } })
  assert.equal(out, undefined)
})