// 纯逻辑核心：过滤 → 幂等 → 握手 → 注入。
// 不 import 任何 node:fs，同步中间件壳也能直接复用。

import { MARK, ACTIVATION } from "./constants.mjs"
import { pick } from "./adapters/index.mjs"
import { extractText } from "./text.mjs"

// 过滤语义与原实现逐条对齐：
//   agents_off 命中 → 跳过（先判，握手也绕不过去）
//   agents 非空且未命中 → 跳过
//   models 非空 → body.model / ctx.model 必须以前缀之一开头
export function filter(ctx, body, o) {
  const agent = typeof ctx.agent === "string" ? ctx.agent : ""

  if (o.agents_off.length && o.agents_off.indexOf(agent) !== -1) return "skip-agent-off"
  if (o.agents.length && o.agents.indexOf(agent) === -1) return "skip-agent-list"

  if (o.models.length) {
    const model = String((body && body.model) || ctx.model || "")
    if (!o.models.some((m) => model.indexOf(m) === 0)) return "skip-model"
  }

  if (o.skip_stream && isStreaming(body, ctx)) return "skip-stream"

  return "allow"
}

// 流式判定：OpenAI / Anthropic / Responses 看 body.stream；
// Gemini 的流式体现在 URL 后缀（:streamGenerateContent），body 里没有该字段。
function isStreaming(body, ctx) {
  if (body && body.stream === true) return true
  const p = ctx && typeof ctx.path === "string" ? ctx.path : ""
  return p.indexOf("streamGenerateContent") !== -1
}

// 末条用户消息恰好等于激活词 → 轻路由。
function isActivation(body, protocol) {
  const last = lastUserText(body, protocol)
  if (!last) return false
  const t = last.trim()
  if (!t) return false
  return ACTIVATION.some((w) => t === w)
}

function lastUserText(body, protocol) {
  if (!body) return ""
  if (protocol === "gemini") {
    const arr = body.contents
    if (!Array.isArray(arr)) return ""
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i]
      if (m && m.role === "user") return extractText(m.parts) || ""
    }
    return ""
  }
  if (protocol === "responses") {
    const inp = body.input
    if (typeof inp === "string") return inp
    if (Array.isArray(inp)) {
      for (let i = inp.length - 1; i >= 0; i--) {
        const m = inp[i]
        if (m && (m.role === "user" || m.type === "message")) return extractText(m.content) || ""
      }
    }
    return ""
  }
  const arr = body.messages
  if (!Array.isArray(arr)) return ""
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]
    if (m && m.role === "user") return extractText(m.content) || ""
  }
  return ""
}

// 前置判定：不碰 I/O 就能决定"这个请求要不要处理"。
// 入口层先用它短路，省掉一次 payload 解析（stat + read）。
// 返回 null = 继续；返回 { action, meta } = 直接放行。
export function precheck(body, ctx, o) {
  if (!body || typeof body !== "object") return { action: "skip-body", meta: {} }

  const c = ctx || {}
  const adapter = pick(c.protocol)
  if (!adapter) return { action: "skip-protocol", meta: { protocol: c.protocol ?? null } }

  const verdict = filter(c, body, o)
  if (verdict !== "allow") return { action: verdict, meta: { protocol: adapter.id } }

  return null
}

// 主流程。返回 { body?, action, meta }。
// body === undefined 表示"请求原样放行"——这是 magpie 钩子契约里的逃生门。
export function handle(body, ctx, payload, o) {
  if (!o || !o.dry_run) return run(body, ctx, payload, o)

  // dry_run：在副本上跑完整流程，原请求一个字节都不动。
  // 必须克隆——适配器的 write() 是原地修改 body 的。
  const probe = cloneBody(body)
  if (!probe) return { action: "skip-body", meta: { dry_run: true } }
  const r = run(probe, ctx, payload, o)
  return { action: r.action, meta: { ...(r.meta || {}), dry_run: true } }
}

function run(body, ctx, payload, o) {
  const pre = precheck(body, ctx, o)
  if (pre) return pre

  const c = ctx || {}
  const adapter = pick(c.protocol)
  const existing = adapter.read(body)
  if (typeof existing === "string" && existing.indexOf(MARK) !== -1) {
    return { action: "skip-mark", meta: { protocol: adapter.id } }
  }

  if (o.handshake && isActivation(body, adapter.id)) {
    if (o.handshake_model) body.model = o.handshake_model
    const out = adapter.replace(body, payload.handshake)
    return out
      ? {
          body: out,
          action: "handshake",
          meta: { protocol: adapter.id, model: o.handshake_model || undefined, written: payload.handshake },
        }
      : { action: "skip-write", meta: { protocol: adapter.id } }
  }

  const hasOwn = typeof existing === "string" && existing.trim() !== ""
  if (hasOwn && !o.override) return { action: "skip-override", meta: { protocol: adapter.id } }

  const out = adapter.write(body, payload.text, { position: o.position, cache: o.cache })
  return out
    ? { body: out, action: "inject", meta: { protocol: adapter.id, position: o.position, written: payload.text } }
    : { action: "skip-write", meta: { protocol: adapter.id } }
}

// 深拷贝请求体。structuredClone 优先，遇见函数/循环引用时退回 JSON。
function cloneBody(body) {
  if (!body || typeof body !== "object") return null
  try {
    if (typeof structuredClone === "function") return structuredClone(body)
  } catch {
    // 落到下面的 JSON 路径
  }
  try {
    return JSON.parse(JSON.stringify(body))
  } catch {
    return null
  }
}
