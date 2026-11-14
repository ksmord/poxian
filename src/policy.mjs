// 注入档位策略：纯函数，不碰 fs、不碰网络。
//
// 三档：
//   always     每轮全量（默认，与 0.2.7 行为一致）
//   tiered     首轮 / 拒答锁存命中 / 高风险预判 / 每 N 轮 → 全量；其余 → 骨架
//   on_refusal 只有拒答锁存命中才注入，其余零 token
//
// 为什么骨架不是「200 token 的自造小抄」：
// 实测载荷越短服从率越低（大狗 2364 tok → 35%，富江精简 897 tok → 26%）。
// 骨架默认取已经实测过的 fujiang-lite，不引入没有通过率数据的第三份载荷。

import { hit } from "./latch.mjs"

// 高风险意图：命中就在拒答发生之前把全量挂上。
// 这是 on_refusal 那一档补不上的洞——拒答之后的下一轮才补，用户已经吃过一次闭门羹。
const RISK = /(外挂|透视|自瞄|锁头|免杀|过杀软|绕\s*(defender|卡巴|火绒|360)|loader|dropper|rootkit|勒索|卡密|注册机|破解补丁|钓鱼(站|页|邮件)|跑分|洗钱|水房|分账|假证|身份证模板|护照模板|签证|走私|带货路线|绕卡点|逃税|接码|撞库|盗号)/i

// 会话指纹：agent | model | 首条 user 文本前 160 字。FNV-1a 32 位，够做 Map 键。
export function sessionKey(body, ctx) {
  const c = ctx || {}
  const model = String((body && body.model) || c.model || "")
  const first = (firstUserText(body) || "").replace(/\s+/g, " ").trim().slice(0, 160)
  const seed = `${c.agent || ""}|${model}|${first}`
  return fnv1a(seed)
}

export function firstUserText(body) {
  if (!body || typeof body !== "object") return ""
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && m.role === "user") return textOf(m.content)
    }
  }
  if (Array.isArray(body.contents)) {
    for (const m of body.contents) {
      if (m && m.role === "user") return textOf(m.parts)
    }
  }
  if (typeof body.input === "string") return body.input
  if (Array.isArray(body.input)) {
    for (const m of body.input) {
      if (m && m.role === "user") return textOf(m.content)
    }
  }
  return ""
}

export function lastUserText(body) {
  const list = body && typeof body === "object"
    ? (Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : Array.isArray(body.contents) ? body.contents : [])
    : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (!m) continue
    if (m.role && m.role !== "user") continue
    const t = textOf(m.content !== undefined ? m.content : m.parts)
    if (t) return t
  }
  return firstUserText(body)
}

export function countUserTurns(body) {
  const list = body && typeof body === "object" && Array.isArray(body.messages) ? body.messages : null
  if (list) return list.filter((m) => m && m.role === "user").length
  if (body && Array.isArray(body.contents)) return body.contents.filter((m) => m && m.role === "user").length
  if (Array.isArray(body && body.input)) return body.input.filter((m) => m && m.role === "user").length
  return body && typeof body.input === "string" ? 1 : 0
}

export function risky(text) {
  return RISK.test(String(text || ""))
}

// 返回 "full" | "skeleton" | "none"
// 调用方拿到 tier 后决定载荷来源；none 表示原样放行，一个字节都不碰。
export function decideTier(body, o, key, now = Date.now()) {
  const mode = o.inject_mode
  if (mode === "always") return "full"

  const armed = hit(key, now)
  if (mode === "on_refusal") return armed ? "full" : "none"
  if (mode === "off") return "none"

  // tiered
  if (armed) return "full"
  if (o.risk_preempt !== false && risky(lastUserText(body) || firstUserText(body))) return "full"

  const turns = countUserTurns(body)
  if (turns <= 1) return "full"
  const every = Number(o.tier_full_every) || 0
  if (every > 0 && turns % every === 0) return "full"

  // 没有骨架可用时退回全量：宁可多花 token，也不要在「以为省了」的状态下裸奔。
  if (!String(o.skeleton_prompt || "").trim() && !String(o.skeleton_path || "").trim()) return "full"
  return "skeleton"
}

function textOf(content) {
  if (!content) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const out = []
    for (const p of content) {
      if (!p) continue
      if (typeof p === "string") out.push(p)
      else if (typeof p.text === "string") out.push(p.text)
    }
    return out.join("\n")
  }
  if (typeof content.text === "string") return content.text
  return ""
}

function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return "s_" + h.toString(16).padStart(8, "0")
}
