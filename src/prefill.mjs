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

/* ────────── 按模型自动判断 ──────────
 *
 * prefill_models 是手写白名单，改一次要重启网关。这里补一层运行时判断：
 *   先验（实机实测的固有权重）+ 该路由的滑动统计，两个相加决定开不开。
 *
 * 先验来自 bench/REPORT.md，不是猜的：
 *   hy4      71% → 93%（13/14）   → +2
 *   dp4.1f   71% → 38%            → −2（围栏被当成"用户已开始"，自己在围栏里拒绝）
 *   k3/k3.1  两份载荷 0%，本来就到不了 → −2
 *   glm*     36%，预填无增益        → −0.5
 *
 * 统计是进程内 EWMA（decay 0.75）。core.mjs 约定不碰 fs，所以不落盘：
 * 网关重启就从先验重新开始，代价只是前几条请求少一点证据。
 */

const PRIOR = [
  { re: /^group\/hy4\b/, score: 2, why: "hy4: 实测 71%→93%" },
  { re: /^group\/dp4\.1f\b/, score: -2, why: "dp4.1f: 实测 71%→38%" },
  { re: /^group\/k3(\b|\.)/, score: -2, why: "k3 系: 实测 0%" },
  { re: /^group\/glm/, score: -0.5, why: "glm: 预填无增益" },
]

const STATS = new Map()
const DECAY = 0.75
const MIN_EVIDENCE = 4

function priorOf(model) {
  for (const p of PRIOR) if (p.re.test(model)) return p
  return { score: 0, why: "未登记路由，等证据" }
}

export function notePrefillResult(model, { ok, refused }) {
  const m = String(model || "")
  if (!m) return
  const s = STATS.get(m) || { ok: 0, ref: 0, n: 0, w: 0 }
  s.ok = s.ok * DECAY + (ok ? 1 : 0)
  s.ref = s.ref * DECAY + (refused ? 1 : 0)
  // w 是衰减权重和：EWMA 下 ok/ref 会随次数缩水，必须除回权重才是 [-1,1] 的率。
  s.w = s.w * DECAY + 1
  s.n += 1
  STATS.set(m, s)
}

export function resetPrefillStats() {
  STATS.clear()
}

export function prefillStats(model) {
  return STATS.get(String(model || "")) || { ok: 0, ref: 0, n: 0, w: 0 }
}

// 返回 {on, why}。显式白名单永远优先于自动判断。
export function decidePrefill(o, model) {
  if (!o || !o.prefill) return { on: false, why: "prefill 未配置" }
  const m = String(model || "")
  const list = Array.isArray(o.prefill_models) ? o.prefill_models : []

  if (list.length) {
    const hit = list.some((p) => m === p || (m && m.indexOf(p) === 0))
    return { on: hit, why: hit ? "白名单命中" : "白名单未命中" }
  }

  if (!o.prefill_auto) return { on: false, why: "prefill_auto 关闭" }
  if (!m) return { on: false, why: "取不到模型名" }

  const p = priorOf(m)
  const s = prefillStats(m)
  let score = p.score
  let why = p.why

  if (s.n >= MIN_EVIDENCE) {
    const rate = (s.ok - s.ref) / Math.max(s.w, 1e-9)
    score += 2 * rate
    why += `；统计 n=${s.n} 净率 ${rate.toFixed(2)}`
  } else if (p.score === 0) {
    return { on: false, why: "未登记路由且证据不足（n<4）" }
  }

  return { on: score > 0.5, why: `${why}；score=${score.toFixed(2)}` }
}
