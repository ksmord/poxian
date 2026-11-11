import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { normalize } from "../src/options.mjs"
import { handle, precheck } from "../src/core.mjs"
import { MARK, HANDSHAKE_TEXT, CACHE } from "../src/constants.mjs"
import { resolvePrompt, _resetCache } from "../src/payload.mjs"

const TEXT = MARK + "\nPROMPT-BODY"

function run(body, ctx, opts) {
  const o = normalize(opts)
  return handle(body, ctx, { text: TEXT, handshake: MARK + "\n" + HANDSHAKE_TEXT }, o)
}

test("anthropic: 无 system 时写入字符串", () => {
  const body = { model: "claude", messages: [{ role: "user", content: "hi" }] }
  const r = run(body, { protocol: "anthropic" })
  assert.equal(r.action, "inject")
  assert.equal(body.system, TEXT)
})

// 这一组钉的是 merge（拼接）路径本身。默认已改为 replace，
// 不显式写 override_mode 的话这些断言会全线失效——而且是静默变成 replace 语义。
test("anthropic: merge + prepend 到已有字符串", () => {
  const body = { system: "OWN", messages: [] }
  run(body, { protocol: "anthropic" }, { override_mode: "merge", position: "prepend" })
  assert.equal(body.system, TEXT + "\nOWN")
})

test("anthropic: merge + append 到已有字符串", () => {
  const body = { system: "OWN", messages: [] }
  run(body, { protocol: "anthropic" }, { override_mode: "merge", position: "append" })
  assert.equal(body.system, "OWN\n" + TEXT)
})

test("anthropic: block 数组 merge prepend", () => {
  const body = { system: [{ type: "text", text: "OWN" }], messages: [] }
  run(body, { protocol: "anthropic" }, { override_mode: "merge" })
  assert.equal(body.system.length, 2)
  assert.equal(body.system[0].text, TEXT)
})

// 默认语义：请求自带 system 时整段替换。
// 这是实机 A/B 的结论，不是审美选择——拼接拿不到控制权。
test("anthropic: 默认 replace 整段覆盖", () => {
  const body = { system: "OWN", messages: [] }
  const r = run(body, { protocol: "anthropic" })
  assert.equal(r.action, "inject")
  assert.equal(r.meta.position, "replace")
  assert.equal(body.system, TEXT)
})

test("anthropic: cache 打开时挂 cache_control", () => {
  const body = { messages: [] }
  run(body, { protocol: "anthropic" }, { cache: true })
  assert.deepEqual(body.system[0].cache_control, CACHE)
})

test("幂等：已带 MARK 不再注入", () => {
  const body = { system: TEXT, messages: [] }
  const r = run(body, { protocol: "anthropic" })
  assert.equal(r.action, "skip-mark")
  assert.equal(body.system, TEXT)
})

test("chat: 无 system 时插到最前", () => {
  const body = { messages: [{ role: "user", content: "hi" }] }
  run(body, { protocol: "chat" })
  assert.equal(body.messages[0].role, "system")
  assert.equal(body.messages[0].content, TEXT)
  assert.equal(body.messages.length, 2)
})

// 这条钉的是 merge 路径下「已有 system 时 prepend 拼接」。
// 默认 replace 下同样的请求会被整段覆盖，所以必须显式声明 merge。
test("chat: 已有 system 时 merge prepend 合并", () => {
  const body = { messages: [{ role: "system", content: "OWN" }, { role: "user", content: "x" }] }
  run(body, { protocol: "chat" }, { override_mode: "merge" })
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].content, TEXT + "\nOWN")
})

// 默认语义：chat 的 system 位（含 developer）也要整段替换。
test("chat: 默认 replace 覆盖已有 system", () => {
  const body = { messages: [{ role: "system", content: "OWN" }, { role: "user", content: "x" }] }
  const r = run(body, { protocol: "chat" })
  assert.equal(r.meta.position, "replace")
  assert.equal(body.messages[0].content, TEXT)
  assert.equal(body.messages[1].content, "x")
})

test("responses: 写 instructions", () => {
  const body = { input: "hi" }
  run(body, { protocol: "responses" })
  assert.equal(body.instructions, TEXT)
})

test("gemini: merge 下保留 snake_case 字段名", () => {
  const body = { system_instruction: { parts: [{ text: "OWN" }] }, contents: [] }
  run(body, { protocol: "gemini" }, { override_mode: "merge", position: "append" })
  assert.ok(Array.isArray(body.system_instruction.parts))
  assert.equal(body.system_instruction.parts.length, 2)
  assert.equal(body.systemInstruction, undefined)
})

// replace 同样要守住字段名：不能把 snake_case 请求改写回 camelCase。
test("gemini: replace 下仍保留 snake_case 字段名", () => {
  const body = { system_instruction: { parts: [{ text: "OWN" }] }, contents: [] }
  run(body, { protocol: "gemini" })
  assert.equal(body.system_instruction.parts.length, 1)
  assert.equal(body.system_instruction.parts[0].text, TEXT)
  assert.equal(body.systemInstruction, undefined)
})

test("gemini: 无 system 时建 camelCase", () => {
  const body = { contents: [] }
  run(body, { protocol: "gemini" })
  assert.equal(body.systemInstruction.parts[0].text, TEXT)
})

test("过滤：agents_off 命中", () => {
  const body = { messages: [] }
  const r = run(body, { protocol: "chat", agent: "codex" }, { agents_off: ["codex"] })
  assert.equal(r.action, "skip-agent-off")
  assert.equal(body.messages.length, 0)
})

test("过滤：agents 白名单未命中", () => {
  const r = run({ messages: [] }, { protocol: "chat", agent: "codex" }, { agents: ["claude"] })
  assert.equal(r.action, "skip-agent-list")
})

test("过滤：models 前缀", () => {
  const body = { model: "gpt-4o", messages: [] }
  const r = run(body, { protocol: "chat" }, { models: ["glm-"] })
  assert.equal(r.action, "skip-model")
})

test("override=false：已有 system 跳过", () => {
  const body = { system: "OWN", messages: [] }
  const r = run(body, { protocol: "anthropic" }, { override: false })
  assert.equal(r.action, "skip-override")
})

test("激活词：握手替换整段 system", () => {
  const body = { system: "OWN", messages: [{ role: "user", content: "寒霜" }] }
  const r = run(body, { protocol: "anthropic" })
  assert.equal(r.action, "handshake")
  assert.ok(body.system.indexOf(HANDSHAKE_TEXT) !== -1)
  assert.equal(body.system.indexOf("OWN"), -1)
})

test("激活词：handshake_model 改派", () => {
  const body = { model: "a/b", messages: [{ role: "user", content: "自检" }] }
  run(body, { protocol: "chat" }, { handshake_model: "cheap/x" })
  assert.equal(body.model, "cheap/x")
})

test("未知协议：原样放行", () => {
  const body = { whatever: 1 }
  const r = run(body, { protocol: "grpc" })
  assert.equal(r.action, "skip-protocol")
  assert.equal(r.body, undefined)
})

test("payload：外部文件读取 + 改文件即生效", async () => {
  _resetCache()
  const dir = await mkdtemp(join(tmpdir(), "poxian-"))
  const p = join(dir, "p.md")
  await writeFile(p, "FIRST")
  const a = await resolvePrompt(normalize({ prompt_path: p }), {})
  assert.ok(a.text.startsWith(MARK))
  assert.ok(a.text.indexOf("FIRST") !== -1)

  await writeFile(p, "SECOND")
  const now = new Date(Date.now() + 2000)
  await utimes(p, now, now)

  const b = await resolvePrompt(normalize({ prompt_path: p }), {})
  assert.ok(b.text.indexOf("SECOND") !== -1)
  assert.equal(b.text.indexOf("FIRST"), -1)
})

test("payload：BOM + CRLF + frontmatter", async () => {
  _resetCache()
  const dir = await mkdtemp(join(tmpdir(), "poxian-"))
  const p = join(dir, "b.md")
  await writeFile(p, Buffer.from("\uFEFF---\r\ntitle: x\r\n---\r\nREAL\r\nBODY\r\n", "utf8"))
  const r = await resolvePrompt(normalize({ prompt_path: p }), {})
  assert.ok(r.text.indexOf("REAL\nBODY") !== -1)
  assert.equal(r.text.indexOf("title:"), -1)
})

test("payload：文件缺失回退内置版本", async () => {
  _resetCache()
  const r = await resolvePrompt(normalize({ prompt_path: "/nonexistent/x.md", prompt: "v3" }), {})
  assert.ok(r.source.startsWith("fallback:"))
  assert.ok(r.text.length > 100)
})

test("meta.written：握手记握手文本，注入记主 payload", () => {
  const hs = { system: "OWN", messages: [{ role: "user", content: "寒霜" }] }
  const r1 = run(hs, { protocol: "anthropic" })
  assert.equal(r1.action, "handshake")
  assert.ok(r1.meta.written.indexOf("poxian workbench kernel") !== -1)

  const inj = { system: "OWN", messages: [{ role: "user", content: "普通请求" }] }
  const r2 = run(inj, { protocol: "anthropic" })
  assert.equal(r2.action, "inject")
  assert.equal(r2.meta.written, TEXT)
})

test("precheck: agents_off 命中时不解析载荷就放行", () => {
  const o = normalize({ agents_off: ["claude"] })
  const r = precheck({ messages: [] }, { protocol: "anthropic", agent: "claude" }, o)
  assert.equal(r.action, "skip-agent-off")
  assert.equal(precheck({ messages: [] }, { protocol: "anthropic", agent: "codex" }, o), null)
})

test("dry_run: 照跑全流程，但 body 一个字节不动", () => {
  const body = { system: "OWN", messages: [] }
  const o = normalize({ dry_run: true })
  const r = handle(body, { protocol: "anthropic" }, { text: TEXT, handshake: MARK + "\n" + HANDSHAKE_TEXT }, o)
  assert.equal(r.body, undefined)
  assert.equal(r.action, "inject")
  assert.equal(r.meta.dry_run, true)
  assert.equal(body.system, "OWN")
})

test("prompt_path: 白名单内放行，白名单外回退内置", async () => {
  _resetCache()
  const dir = await mkdtemp(join(tmpdir(), "poxian-allow-"))
  const inside = join(dir, "ok.md")
  await writeFile(inside, "ALLOWED", "utf8")

  const ok = await resolvePrompt(normalize({ prompt_path: inside, prompt_allowlist: [dir] }), {})
  assert.match(ok.source, /^file:/)
  assert.ok(ok.text.includes("ALLOWED"))

  const out = await resolvePrompt(
    normalize({ prompt_path: join(dir, "..", "outside.md"), prompt_allowlist: [dir], prompt: "v3" }),
    {},
  )
  assert.equal(out.source, "fallback:path-blocked")
  assert.equal(out.path_blocked, true)
})

test("prompt_path: 空白名单不限制（旧行为）", async () => {
  _resetCache()
  const dir = await mkdtemp(join(tmpdir(), "poxian-any-"))
  const f = join(dir, "x.md")
  await writeFile(f, "ANYWHERE", "utf8")
  const r = await resolvePrompt(normalize({ prompt_path: f }), {})
  assert.match(r.source, /^file:/)
})

test("max_payload_bytes: 超限降级回内置并打 oversize", async () => {
  const o = normalize({ on_prompt: "X".repeat(500), prompt: "v3", max_payload_bytes: 100 })
  const r = await resolvePrompt(o, {})
  assert.equal(r.source, "fallback:oversize")
  assert.equal(r.oversize, true)
  assert.ok(r.requested_bytes > 100)
  assert.ok(r.bytes > 0)
})

test("max_payload_bytes: 0 表示不限制", async () => {
  const r = await resolvePrompt(normalize({ on_prompt: "X".repeat(500) }), {})
  assert.equal(r.source, "literal")
  assert.equal(r.oversize, undefined)
})
