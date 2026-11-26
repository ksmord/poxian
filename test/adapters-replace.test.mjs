// replace 语义的实测测试：验证「只留我的这一套」真的成立。
//
// 为什么必须有这个文件：旧实现在 replace 时只换第一条 system，把剩余的
// system/developer 原样留着。模型照样读到供应商对齐条款，注入被顶掉一半，
// 表现就是「拒答特别多」。这种缺陷用「看代码」查不出来，必须用多 system 的夹具钉住。
//
// 判据是**计数**级，不是「看起来对不对」：
//   replace 之后，消息数组里 role 为 system/developer 的必须恰好 1 条。
import test from "node:test"
import assert from "node:assert/strict"
import chat from "../src/adapters/chat.mjs"
import responses from "../src/adapters/responses.mjs"
import anthropic from "../src/adapters/anthropic.mjs"
import gemini from "../src/adapters/gemini.mjs"

const isSys = (m) => m && (m.role === "system" || m.role === "developer")
const sysCount = (list) => (Array.isArray(list) ? list.filter(isSys).length : 0)

/* ────────────────────────── chat ────────────────────────── */

test("chat/replace: 多条 system 与 developer 全部清掉，只留注入的这一条", () => {
  const b = {
    messages: [
      { role: "system", content: "原生 A" },
      { role: "developer", content: "原生 B" },
      { role: "system", content: "原生 C" },
      { role: "user", content: "问题" },
    ],
  }
  const out = chat.replace(b, "注入载荷")
  assert.equal(sysCount(out.messages), 1, "replace 后只能剩一条 system")
  assert.equal(out.messages[0].role, "system")
  assert.equal(out.messages[0].content, "注入载荷")
  assert.equal(out.messages.at(-1).content, "问题", "user 消息不能被吃掉")
})

test("chat/replace: 就地改写并返回同一对象（这是既有契约，不是纯函数）", () => {
  // 为什么这么判：core.mjs 的写入路径是「先克隆 → 调 replace → 用 next !== body 判改动」。
  // replace 的契约就是原地改写返回同体。断言它不改入参等于否定契约本身。
  const b = { messages: [{ role: "system", content: "原生" }, { role: "user", content: "q" }] }
  const out = chat.replace(b, "注入")
  assert.equal(out, b, "必须返回同一个对象")
  assert.equal(b.messages[0].content, "注入", "入参被原地改写是预期行为")
})

test("chat/replace: 带 tool_calls 的 system 项保守保留（§4 互斥条件）", () => {
  const b = {
    messages: [
      { role: "system", content: "原生" },
      { role: "system", content: "工具说明", tool_calls: [{ id: "t1" }] },
      { role: "user", content: "q" },
    ],
  }
  const out = chat.replace(b, "注入")
  assert.equal(sysCount(out.messages), 2, "带 tool_calls 的不能删，拿不准就不动")
})

test("chat/replace: content 是数组块时不碰（多模态）", () => {
  const b = {
    messages: [
      { role: "system", content: "原生" },
      { role: "system", content: [{ type: "text", text: "块结构" }] },
      { role: "user", content: "q" },
    ],
  }
  const out = chat.replace(b, "注入")
  assert.equal(sysCount(out.messages), 2, "数组块结构拿不准，保留")
})

test("chat/replace: 非空守卫 —— 空串/非字符串一律不写", () => {
  const b = { messages: [{ role: "user", content: "q" }] }
  assert.equal(chat.replace(b, ""), undefined)
  assert.equal(chat.replace(b, null), undefined)
  assert.equal(chat.replace(b, 123), undefined)
  assert.equal(b.messages.length, 1, "守卫挡住的调用不得留下半截写入")
})

/* ──────────────────────── responses ──────────────────────── */

test("responses/replace: input 里的 system 与 developer 全部清掉", () => {
  const b = {
    instructions: "原生 instructions",
    input: [
      { role: "system", content: "原生 input[0]" },
      { role: "developer", content: "原生 input[1]" },
      { role: "user", content: "问题" },
    ],
  }
  const out = responses.replace(b, "注入载荷")
  assert.equal(out.instructions, "注入载荷")
  assert.equal(sysCount(out.input), 0, "input 里不得残留 system/developer")
  assert.equal(out.input.length, 1)
  assert.equal(out.input[0].content, "问题")
})

test("responses/replace: input 是字符串时不动（无 role 结构）", () => {
  const b = { instructions: "原生", input: "整段文本" }
  const out = responses.replace(b, "注入")
  assert.equal(out.input, "整段文本")
})

test("responses/replace: 带 tool_call_id 的条目保守保留", () => {
  const b = {
    instructions: "原生",
    input: [
      { role: "system", content: "工具说明", tool_call_id: "c1" },
      { role: "user", content: "q" },
    ],
  }
  const out = responses.replace(b, "注入")
  assert.equal(sysCount(out.input), 1, "带工具结构的不动")
})

test("responses/replace: 就地改写并返回同一对象（既有契约）", () => {
  const b = { instructions: "原生", input: [{ role: "system", content: "s" }, { role: "user", content: "q" }] }
  const out = responses.replace(b, "注入")
  assert.equal(out, b)
  assert.equal(b.instructions, "注入")
  assert.equal(sysCount(b.input), 0, "input 里的 system 必须已被清掉")
})

/* ─────────────────── anthropic / gemini 一致性 ─────────────────── */

test("anthropic/replace: 字符串 system 被整体替换", () => {
  const b = { system: "原生对齐条款" }
  const out = anthropic.replace(b, "注入载荷")
  assert.equal(out.system, "注入载荷")
})

test("anthropic/replace: 数组形式 system 也是整体替换，不保留原生块", () => {
  const b = { system: [{ type: "text", text: "原生块" }] }
  const out = anthropic.replace(b, "注入载荷")
  const text = typeof out.system === "string" ? out.system : JSON.stringify(out.system)
  assert.ok(text.includes("注入载荷"))
  assert.ok(!text.includes("原生块"), "数组形式也必须清干净")
})

test("gemini/replace: camel 与 snake 两种 systemInstruction 都不残留原生", () => {
  const b = { systemInstruction: { parts: [{ text: "原生 camel" }] }, system_instruction: { parts: [{ text: "原生 snake" }] } }
  const out = gemini.replace(b, "注入载荷")
  const flat = JSON.stringify(out)
  assert.ok(flat.includes("注入载荷"))
  assert.ok(!flat.includes("原生 camel"), "camel 键的原生内容必须清掉")
  assert.ok(!flat.includes("原生 snake"), "snake 键的原生内容必须清掉")
})