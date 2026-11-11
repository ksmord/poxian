// 报文清洗：纯函数，不碰 fs / 网络 / 时钟。
//
// 目的只有一个：客户端已经带上、且与本网关注入相冲突的 system 约束，
// 在注入之前清掉——否则 inject 出去的内容会被上游自带的 system 覆盖，
// 表现为「配了提示词但模型不认」。
//
// 设计约束：
//   1. 只读形状、不认协议 id。chat 的 messages、Anthropic 的 system、
//      Responses 的 instructions、Gemini 的 systemInstruction 四种形状全覆盖，
//      新增协议只要落在其中一种形状上就自动生效。
//   2. 不原地改入参。命中才克隆并返回新对象，未命中直接返回原引用，
//      调用方用 `next !== body` 判断"到底改没改"。
//   3. 删除 assistant 历史后做同角色合并。Anthropic / Gemini 要求 user 与
//      assistant 交替，直接删一条会变成连续两条 user，上游当场 400。

import { extractText } from "./text.mjs"

// 命中即整段移除的 system 关键词。
// CJK 无大小写，但统一走小写比较，英文关键词也能命中。
export const SAFETY_KEYWORDS = [
  "安全约束",
  "你是安全助手",
  "遵守法律",
  "不能生成",
  "禁止",
  "合规要求",
]

// 历史 assistant 里的拒绝话术。
export const DENY_PHRASES = [
  "抱歉",
  "不能",
  "无法",
  "不便提供",
  "不支持",
  "遵守相关规定",
]

const lower = (v) => String(v === null || v === undefined ? "" : v).toLowerCase()

function hits(text, list) {
  const t = lower(text)
  if (!t) return false
  for (let i = 0; i < list.length; i++) {
    if (t.indexOf(lower(list[i])) !== -1) return true
  }
  return false
}

// 任意 content 形状 → 纯文本。取不到当空串（图片块、未知块都不算命中）。
function textOf(v) {
  const t = extractText(v)
  return typeof t === "string" ? t : ""
}

// 保留未命中关键词的块。字符串块与对象块都吃。
function keepClean(blocks, list) {
  const out = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const t = textOf(b)
    if (t && hits(t, list)) continue
    out.push(b)
  }
  return out
}

function clone(body) {
  try {
    if (typeof structuredClone === "function") return structuredClone(body)
  } catch {
    // 含函数 / 循环引用：落到 JSON
  }
  try {
    return JSON.parse(JSON.stringify(body))
  } catch {
    return null
  }
}

// 两条同角色消息合成一条：字符串拼字符串，其余统一成 block 数组。
function mergeContent(a, b) {
  const ta = textOf(a)
  const tb = textOf(b)
  if (typeof a === "string" && typeof b === "string") {
    return [ta, tb].filter(Boolean).join("\n")
  }
  const blocks = []
  const push = (v) => {
    if (Array.isArray(v)) blocks.push(...v)
    else if (typeof v === "string") {
      if (v) blocks.push({ type: "text", text: v })
    } else if (v && typeof v === "object") blocks.push(v)
  }
  push(a)
  push(b)
  return blocks
}

// roles 交替修正：只合并相邻同角色，不改顺序、不改语义顺序。
function mergeSameRole(list) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const prev = out[out.length - 1]
    if (prev && m && prev.role === m.role) {
      prev.content = mergeContent(prev.content, m.content)
      continue
    }
    out.push(m)
  }
  return out
}

// chat：system / developer 在 messages 里，assistant 拒绝历史也在这里。
function cleanMessages(list, stripSystem, stripDeny) {
  let out = list
  let changed = false

  if (stripSystem) {
    const kept = out.filter((m) => {
      if (!m || typeof m !== "object") return true
      if (m.role !== "system" && m.role !== "developer") return true
      const t = textOf(m.content)
      return !(t && hits(t, SAFETY_KEYWORDS))
    })
    if (kept.length !== out.length) {
      out = kept
      changed = true
    }
  }

  if (stripDeny) {
    const kept = out.filter((m) => {
      if (!m || typeof m !== "object") return true
      if (m.role !== "assistant") return true
      const t = textOf(m.content)
      return !(t && hits(t, DENY_PHRASES))
    })
    if (kept.length !== out.length) {
      out = mergeSameRole(kept)
      changed = true
    }
  }

  return { list: out, changed }
}

// Anthropic：system 是 string 或 block 数组。
function cleanSystemString(req) {
  if (typeof req.system !== "string") return false
  if (!hits(req.system, SAFETY_KEYWORDS)) return false
  delete req.system
  return true
}

function cleanSystemBlocks(req) {
  if (!Array.isArray(req.system)) return false
  const kept = keepClean(req.system, SAFETY_KEYWORDS)
  if (kept.length === req.system.length) return false
  if (kept.length) req.system = kept
  else delete req.system
  return true
}

// Gemini：systemInstruction / system_instruction，形状 string 或 { parts: [...] }。
// 保留请求原本用的字段名，不擅自 camel/snake 互转。
function cleanGeminiSystem(req) {
  let changed = false
  const keys = ["systemInstruction", "system_instruction"]
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const v = req[k]
    if (v === undefined || v === null) continue

    if (typeof v === "string") {
      if (hits(v, SAFETY_KEYWORDS)) {
        delete req[k]
        changed = true
      }
      continue
    }

    if (v && typeof v === "object" && Array.isArray(v.parts)) {
      const kept = keepClean(v.parts, SAFETY_KEYWORDS)
      if (kept.length === v.parts.length) continue
      changed = true
      if (kept.length) req[k] = { ...v, parts: kept }
      else delete req[k]
    }
  }
  return changed
}

// Responses：system 位是 instructions；历史在 input 数组的 assistant 项里。
function cleanResponses(req, stripSystem, stripDeny) {
  let changed = false

  if (stripSystem && typeof req.instructions === "string") {
    if (hits(req.instructions, SAFETY_KEYWORDS)) {
      delete req.instructions
      changed = true
    }
  }

  if (stripDeny && Array.isArray(req.input)) {
    const kept = req.input.filter((m) => {
      if (!m || typeof m !== "object") return true
      if (m.role !== "assistant") return true
      const t = textOf(m.content)
      return !(t && hits(t, DENY_PHRASES))
    })
    if (kept.length !== req.input.length) {
      // 这里不合并相邻同角色：Responses 的 input 允许连续同角色，
      // 合并反而会把带 type/metadata 的独立 message 项揉在一起。
      req.input = kept
      changed = true
    }
  }

  return changed
}

// Gemini：contents 里 assistant 的 role 是 "model"。
function cleanGeminiContents(req, stripDeny) {
  if (!stripDeny || !Array.isArray(req.contents)) return false

  const kept = req.contents.filter((m) => {
    if (!m || typeof m !== "object") return true
    if (m.role !== "model") return true
    const t = textOf(m.parts)
    return !(t && hits(t, DENY_PHRASES))
  })
  if (kept.length === req.contents.length) return false

  // Gemini 这里不交替合并：contents 连续同角色是合法的，合并反而会
  // 把两条 functionCall 揉成一条。
  req.contents = kept
  return true
}

/**
 * 报文清洗主入口。
 *
 * @param {object} body  请求体（不会被原地修改）
 * @param {object} opts  { enabled, strip_safety_system, strip_deny_assistant }
 * @returns {object} 命中时返回新的请求体，未命中返回原引用
 */
export function filterMessages(body, opts) {
  const o = opts || {}
  if (o.enabled !== true || !body || typeof body !== "object") return body

  const stripSystem = o.strip_safety_system !== false
  const stripDeny = o.strip_deny_assistant === true
  if (!stripSystem && !stripDeny) return body

  const req = clone(body)
  if (!req) return body

  let changed = false

  if (Array.isArray(req.messages)) {
    const r = cleanMessages(req.messages, stripSystem, stripDeny)
    if (r.changed) {
      req.messages = r.list
      changed = true
    }
  }

  if (stripSystem && cleanSystemString(req)) changed = true
  if (stripSystem && cleanSystemBlocks(req)) changed = true
  if (stripSystem && cleanGeminiSystem(req)) changed = true
  if (cleanResponses(req, stripSystem, stripDeny)) changed = true
  if (cleanGeminiContents(req, stripDeny)) changed = true

  return changed ? req : body
}

export default filterMessages
