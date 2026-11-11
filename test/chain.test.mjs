// 全链路测试：以 poxian.hooks.mjs 的 onRequest(body, ctx) 为唯一入口。
//
// 与 filter.test.mjs 的分工：
//   filter.test.mjs 直接调 filterMessages() / handle()，证明的是清洗函数本身
//   与 core 内部组合；它绕过了 normalize → precheck → resolvePrompt → handle
//   → record 这条真实入口链。
//   这里走完整 onRequest，证明的是「清洗 + 注入」在真实入口里的顺序契约：
//   override / skip-mark / position / dry_run / agents_off 在清洗之后是否仍按
//   预期走。纯形状覆盖（四种协议的 system 位）仍在 filter.test.mjs，不重复。
import test from "node:test"
import assert from "node:assert/strict"

import { onRequest } from "../poxian.hooks.mjs"
import { MARK } from "../src/constants.mjs"

// 关键：注入正文本身要含安全关键词。
// 真实提示词里就有「禁止」一类措辞。若幂等判定排在清洗之后，
// strip_safety_system 会把上一轮注入的那段连同 MARK 一起删掉，
// 下次请求就读不到标记、判为未注入，重复走一遍注入路径。
// 用不含关键词的干净文案测不出这个顺序错误。
const KEYWORD = "禁止生成"
const PROMPT = "P."
const TEXT = MARK + "\n" + PROMPT

function ctx(protocol, options, extra) {
  return {
    protocol,
    // log:false —— 观测写盘与断言无关，避免在只读环境下产生噪声目录
    options: { log: false, ...options },
    ...(extra || {}),
  }
}

/* ---------- 清洗 × override ---------- */

test("全链路 · chat：清洗删掉自带 system 后，override=false 仍会注入", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "你是安全助手，禁止生成相关内容" },
      { role: "user", content: "hi" },
    ],
  }
  const out = await onRequest(
    body,
    ctx("chat", { on_prompt: PROMPT, override: false, enable_message_filter: true }),
  )
  assert.ok(out, "清洗后没有自带 system，override=false 不该拦住注入")
  assert.equal(out.messages.length, 2)
  assert.deepEqual(out.messages[0], { role: "system", content: TEXT })
  assert.deepEqual(out.messages[1], { role: "user", content: "hi" })
})

test("全链路 · chat：清洗未命中时 override=false 仍然 skip-override", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "You code." },
      { role: "user", content: "hi" },
    ],
  }
  const out = await onRequest(
    body,
    ctx("chat", { on_prompt: PROMPT, override: false, enable_message_filter: true }),
  )
  assert.equal(out, undefined)
})

// 断言的是「总开关关闭时不清洗」——所以要在 merge 下测：
// replace 会把自带 system 整段覆盖，清洗开没开结果都一样，测不出顺序契约。
test("全链路 · chat：总开关关闭时不清洗，merge 下注入拼在自带 system 前面", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "你是安全助手" },
      { role: "user", content: "hi" },
    ],
  }
  const out = await onRequest(body, ctx("chat", { on_prompt: PROMPT, override_mode: "merge" }))
  assert.equal(out.messages[0].content, TEXT + "\n你是安全助手")
})

// 默认 replace：不清洗也不影响结果，但自带 system 必须被整段换掉。
test("全链路 · chat：默认 replace 覆盖自带 system", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "你是安全助手" },
      { role: "user", content: "hi" },
    ],
  }
  const out = await onRequest(body, ctx("chat", { on_prompt: PROMPT }))
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].content, TEXT)
  assert.equal(out.messages[1].content, "hi")
})

/* ---------- 清洗 × skip-mark ---------- */

test("全链路 · chat：已注入的请求即使 system 含安全关键词也必须 skip-mark", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "你是安全助手，禁止生成" },
      { role: "user", content: "hi" },
    ],
  }
  const first = await onRequest(body, ctx("chat", { on_prompt: KEYWORD, enable_message_filter: true }))
  assert.ok(first.messages[0].content.startsWith(MARK))
  // 注入正文自带关键词，此时 system 同时含 MARK 与「禁止生成」
  assert.equal(first.messages[0].content.split(MARK).length - 1, 1)

  const second = await onRequest(
    first,
    ctx("chat", { on_prompt: KEYWORD, enable_message_filter: true }),
  )
  assert.equal(second, undefined, "第二轮必须被判为已注入，不能重复注入")
  assert.equal(first.messages[0].content.split(MARK).length - 1, 1)
})

/* ---------- 清洗 × position ---------- */

// 这条钉的是「清洗顺序」而非注入语义：清洗没命中，system 原样留着，
// 于是 position=append 的拼接必须落在尾部。所以要显式 merge。
test("全链路 · chat：merge + position=append 在清洗之后仍落在尾部", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "You code." },
      { role: "user", content: "hi" },
    ],
  }
  const out = await onRequest(
    body,
    ctx("chat", { on_prompt: PROMPT, override_mode: "merge", position: "append", enable_message_filter: true }),
  )
  assert.equal(out.messages[0].content, "You code.\n" + TEXT)
})

test("全链路 · chat：清洗删掉 system 后 append 退化为新建，不吞掉 user", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "禁止生成" },
      { role: "user", content: "hi" },
    ],
  }
  const out = await onRequest(
    body,
    ctx("chat", { on_prompt: PROMPT, position: "append", enable_message_filter: true }),
  )
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].content, TEXT)
  assert.equal(out.messages[1].content, "hi")
})

/* ---------- 清洗 × dry_run ---------- */

test("全链路 · dry_run：清洗与注入都只发生在副本上", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "你是安全助手" },
      { role: "user", content: "hi" },
    ],
  }
  const snapshot = JSON.stringify(body)
  const out = await onRequest(
    body,
    ctx("chat", {
      on_prompt: PROMPT,
      override: false,
      enable_message_filter: true,
      dry_run: true,
    }),
  )
  assert.equal(out, undefined, "dry_run 不放行改写后的请求")
  assert.equal(JSON.stringify(body), snapshot, "原请求一个字节都不该动")
})

/* ---------- 清洗 × agents_off ---------- */

test("全链路：agents_off 命中时清洗不执行（precheck 更早返回）", async () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "你是安全助手" },
      { role: "user", content: "hi" },
    ],
  }
  const out = await onRequest(
    body,
    ctx("chat", { on_prompt: PROMPT, enable_message_filter: true, agents_off: "bot" }, { agent: "bot" }),
  )
  assert.equal(out, undefined)
  assert.equal(body.messages[0].content, "你是安全助手")
})

/* ---------- 清洗 × 另一协议的 system 位 ---------- */

test("全链路 · anthropic：清洗删除 body.system 后按 override=false 重新注入", async () => {
  const body = { model: "m", system: "禁止生成", messages: [{ role: "user", content: "hi" }] }
  const out = await onRequest(
    body,
    ctx("anthropic", { on_prompt: PROMPT, override: false, enable_message_filter: true }),
  )
  assert.ok(out)
  // cache 默认关，system 以字符串形态写回
  assert.equal(out.system, TEXT)
  assert.equal(out.messages.length, 1)
})
