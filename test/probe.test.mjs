// 探针单元测试：只测纯函数判定，不碰网络。
// 判定逻辑错一个分支，日志里的 probe_hit 就会骗人——比没有探针更糟。

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  makeNonce,
  echoInstruction,
  withEcho,
  replyText,
  detectRefusal,
  detectEcho,
  judge,
} from "../src/probe.mjs"

test("makeNonce: 定长、只含 base32 字符、两次不同", () => {
  const a = makeNonce()
  const b = makeNonce()
  assert.equal(a.length, 6)
  assert.match(a, /^[A-HJ-NP-Z2-9]{6}$/)
  assert.notEqual(a, b) // 随机源，撞车概率 1/32^6
})

test("withEcho: 空 nonce 原样返回（调用方无须分支）", () => {
  assert.equal(withEcho("hello", ""), "hello")
  assert.equal(withEcho("hello", null), "hello")
})

test("withEcho: 追加标记与指令，原正文完整保留", () => {
  const out = withEcho("原始载荷", "ABC234")
  assert.ok(out.startsWith("原始载荷"))
  assert.ok(out.includes("[PX-ABC234]"))
  assert.ok(out.includes("第一行"))
})

test("echoInstruction: 同一 nonce 产出稳定文本", () => {
  assert.equal(echoInstruction("XY7Z89"), echoInstruction("XY7Z89"))
})

test("replyText: 四种协议形状都能抽", () => {
  // OpenAI chat
  assert.equal(
    replyText({ choices: [{ message: { content: "A" } }] }),
    "A",
  )
  // Anthropic
  assert.equal(replyText({ content: [{ type: "text", text: "B" }] }), "B")
  // Responses
  assert.equal(
    replyText({ output: [{ content: [{ type: "text", text: "C" }] }] }),
    "C",
  )
  // Gemini
  assert.equal(
    replyText({ candidates: [{ content: { parts: [{ text: "D" }] } }] }),
    "D",
  )
})

test("replyText: 抽取不到返回 null，与「抽到空串」区分开", () => {
  assert.equal(replyText(null), null)
  assert.equal(replyText({ unknown: 1 }), null)
  assert.equal(replyText({ choices: [{ message: { content: "" } }] }), "")
})

test("replyText: 推理模型 content 为空时退到 reasoning_content", () => {
  const r = { choices: [{ message: { content: null, reasoning_content: "思考中" } }] }
  assert.equal(replyText(r), "思考中")
})

test("detectRefusal: 典型中文拒答开头命中", () => {
  for (const s of [
    "我不能帮你写这个。",
    "很抱歉，这个请求我无法完成。",
    "这个我做不了。",
    "我无法协助制作外挂。",
    "恕难从命。",
  ]) {
    assert.equal(detectRefusal(s).refusal, true, s)
  }
})

test("detectRefusal: 英文拒答命中", () => {
  for (const s of [
    "I can't help with that.",
    "I cannot provide this.",
    "I'm sorry, but I can't.",
    "As an AI, I must decline.",
    "Unfortunately I can't assist.",
  ]) {
    assert.equal(detectRefusal(s).refusal, true, s)
  }
})

test("detectRefusal: 正常技术回答不误判", () => {
  for (const s of [
    "这个函数不能为空，否则会崩。",
    "```cpp\nHANDLE h=OpenProcess(PROCESS_ALL_ACCESS,0,pid);\n```",
    "下面是完整实现：先定位进程，再读模块基址。",
    "抱歉的话术不应该出现在这里——这是代码注释。", // 「抱歉」不在开头
  ]) {
    assert.equal(detectRefusal(s).refusal, false, s)
  }
})

test("detectRefusal: 抽不到正文时返回 null，不冒充「没拒」", () => {
  assert.equal(detectRefusal(null).refusal, null)
  assert.equal(detectRefusal("").refusal, null)
  assert.equal(detectRefusal("   ").refusal, null)
})

test("detectEcho: 命中的判定", () => {
  assert.equal(detectEcho("[PX-ABC234]\n正文", "ABC234"), true)
  assert.equal(detectEcho("正文里顺手提了一句 PX-ABC234", "ABC234"), true)
  assert.equal(detectEcho("没有标记", "ABC234"), false)
  assert.equal(detectEcho(null, "ABC234"), null)
  assert.equal(detectEcho("任意", ""), null) // 没开探针 = 判不了
})

test("judge: 两个开关各自独立，关掉的不出现在结果里", () => {
  const reply = { choices: [{ message: { content: "[PX-ZZ9999]\n下面是代码" } }] }
  const onlyEcho = judge({ reply, nonce: "ZZ9999", wantEcho: true, wantRefusal: false })
  assert.equal(onlyEcho.probe_hit, true)
  assert.equal("refusal" in onlyEcho, false)

  const onlyRefusal = judge({ reply, nonce: null, wantEcho: false, wantRefusal: true })
  assert.equal(onlyRefusal.refusal, false)
  assert.equal("probe_hit" in onlyRefusal, false)
})

test("judge: 回显到了但内容仍是拒答——两种事实同时成立", () => {
  const reply = {
    choices: [{ message: { content: "[PX-ABC234]\n我不能帮你做这个。" } }],
  }
  const r = judge({ reply, nonce: "ABC234", wantEcho: true, wantRefusal: true })
  assert.equal(r.probe_hit, true)   // 载荷到达并被执行了格式指令
  assert.equal(r.refusal, true)     // 但正文依然拒答
})
