// 预填（assistant prefill）：把回复的首行先写成工件开头，模型只能往下续。
//
// ── 为什么有效 ────────────────────────────────────────────────────
// 拒答是一条「开场路径」：模型在没有约束的第一句话上做分类，判成敏感就直接收尾。
// 把首行替它写好，等于把分类点从「我该怎么答」挪到「这段代码怎么接着写」——
// 实测 hy4 上 71% → 93%（13/14），比任何提示词改写都便宜。
//
// ── 为什么按路由开 ────────────────────────────────────────────────
// 同一个开关在 group/dp4.1f 上是负收益（71% → 38%）：那条上游会把预填的围栏当成
// 「用户已开始写」，然后自己在围栏里补一句拒绝。所以只在实测有效的路由上开。
//
// ── 不做的事 ──────────────────────────────────────────────────────
// 不改 system、不动 user、不追加新轮次。只在最后补一条 assistant，
// 协议不支持就整段跳过，宁可没有增益也不能写坏请求。

// 末条已经是 assistant 时，接在它后面而不是再加一条——
// Anthropic 的 messages 必须 user/assistant 交替，连续两条 assistant 直接 400。
function appendToLast(body, role, text) {
  if (!Array.isArray(body.messages)) return false
  const last = body.messages[body.messages.length - 1]
  if (last && last.role === role) {
    if (typeof last.content === "string") {
      last.content = last.content + text
      return true
    }
    if (Array.isArray(last.content)) {
      last.content.push({ type: "text", text })
      return true
    }
  }
  return false
}

export function applyPrefill(body, protocol, text) {
  const t = typeof text === "string" ? text : ""
  if (!t) return false
  if (!body || typeof body !== "object") return false

  if (protocol === "chat") {
    if (!Array.isArray(body.messages)) return false
    if (appendToLast(body, "assistant", t)) return true
    body.messages.push({ role: "assistant", content: t })
    return true
  }

  if (protocol === "anthropic") {
    if (!Array.isArray(body.messages)) return false
    if (appendToLast(body, "assistant", t)) return true
    body.messages.push({ role: "assistant", content: [{ type: "text", text: t }] })
    return true
  }

  // responses / gemini：没有等价的「续写末条」语义，直接跳过。
  return false
}

// 路由匹配：空列表 = 全开；否则按前缀匹配模型名。
export function prefillWanted(o, model) {
  if (!o || !o.prefill) return false
  const list = Array.isArray(o.prefill_models) ? o.prefill_models : []
  if (!list.length) return true
  const m = String(model || "")
  if (!m) return false
  return list.some((p) => m === p || m.indexOf(p) === 0)
}
