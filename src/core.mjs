// 纯逻辑核心：过滤 → 幂等 → 清洗 → 握手 → 注入。
// 不 import 任何 node:fs，同步中间件壳也能直接复用。

import { MARK, ACTIVATION } from "./constants.mjs"
import { pick } from "./adapters/index.mjs"
import { extractText } from "./text.mjs"
import { filterMessages } from "./filter.mjs"

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

  // 幂等判定必须排在清洗之前。
  // 理由：注入内容（MARK + 提示词正文）自身就含「禁止」一类安全关键词。
  // 若先清洗，strip_safety_system 会把上一轮注入的这一段连同 MARK 一起删掉，
  // 下一次请求读到空 system → 判为「未注入」→ 重复走一遍注入。
  // 后果不是内容丢失（会重新写入），而是：
  //   - 每个请求白付一次克隆与清洗；
  //   - 日志 filtered 恒为 true，注入次数的对账全部失真。
  // 这条与「清洗放在 existing 判定之前」不冲突：override=false 依赖的是
  // 清洗之后的 existing，而幂等依赖的是清洗之前的原始标记。
  const marked = adapter.read(body)
  if (typeof marked === "string" && marked.indexOf(MARK) !== -1) {
    return { action: "skip-mark", meta: { protocol: adapter.id } }
  }

  // 报文清洗：precheck 之后、幂等标记之后、override 判定之前。
  // 位置理由：
  //   - 放在 precheck 之后 —— 被 skip-* 挡掉的请求不该付清洗成本；
  //   - 放在读 existing 之前 —— 否则删掉自带 system 后，override=false
  //     会拿"删之前有没有 system"来判，语义错位。
  const f = applyFilter(body, o)
  body = f.body
  const filtered = f.changed

  // 清洗标记只进日志与 meta，不进报文。
  const tag = filtered ? { filtered: true } : {}

  const existing = adapter.read(body)

  if (o.handshake && isActivation(body, adapter.id)) {
    if (o.handshake_model) body.model = o.handshake_model
    const out = adapter.replace(body, payload.handshake)
    return out
      ? {
          body: out,
          action: "handshake",
          meta: { protocol: adapter.id, model: o.handshake_model || undefined, written: payload.handshake, ...tag },
        }
      : { action: "skip-write", meta: { protocol: adapter.id, ...tag } }
  }

  const hasOwn = typeof existing === "string" && existing.trim() !== ""
  if (hasOwn && !o.override) return { action: "skip-override", meta: { protocol: adapter.id, ...tag } }

  // override=true 且请求已自带 system 时，默认整段替换而不是拼接。
  // 依据是实机 A/B 结论（group/k3 干净模型，四组对照）：
  //   自带 system + prepend 注入 → 模型仍是原生人格，注入读到了但没取得控制权
  //   自带 system + append  注入 → 同上，位置对结果没有影响
  //   system 位只留注入          → 注入生效
  // 也就是说「前置 = 更高优先级」这个假设不成立：只要原 system 还在，
  // 模型会稳定按原 system 的身份回答。所以要让注入真正生效，必须替换。
  //
  // position 仍然生效：它在 override_mode 为 merge 时决定拼接方向，
  // 在 replace 模式下无意义（整段覆盖）。
  if (o.override_mode === "replace" && hasOwn) {
    const out = adapter.replace(body, payload.text, { cache: o.cache })
    return out
      ? {
          body: out,
          action: "inject",
          meta: { protocol: adapter.id, position: "replace", written: payload.text, ...tag },
        }
      : { action: "skip-write", meta: { protocol: adapter.id, ...tag } }
  }

  const out = adapter.write(body, payload.text, { position: o.position, cache: o.cache })
  return out
    ? {
        body: out,
        action: "inject",
        meta: { protocol: adapter.id, position: o.position, written: payload.text, ...tag },
      }
    : { action: "skip-write", meta: { protocol: adapter.id, ...tag } }
}

// 报文清洗的接线层。开关都在 options 里归一过，这里只做组合：
//   enable_message_filter=false → 一律不动（默认，旧行为）
//
// 不做 per-agent 豁免。这里曾经写过 `ctx.tags.includes("agent")` ——
// ctx.tags 在 magpie 的钩子契约里并不存在（仓库里 ctx 的字段只有
// agent / model / protocol / path / stream / options / cwd），
// 那条分支在真实流量里永远不会触发，而用例手工塞 tags 照样是绿的。
// 「让某个 agent 不吃清洗」请用已有的 agents / agents_off：
// 它们在 precheck 里比清洗更早判定，是真实存在的契约字段。
// 返回 { body, changed }。changed=true 时 body 是新对象，原引用未被修改。
function applyFilter(body, o) {
  if (!o.enable_message_filter) return { body, changed: false }

  const next = filterMessages(body, {
    enabled: true,
    strip_safety_system: o.strip_safety_system,
    strip_deny_assistant: o.strip_deny_assistant,
  })

  return next === body ? { body, changed: false } : { body: next, changed: true }
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
