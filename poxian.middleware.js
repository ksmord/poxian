// poxian · magpie 网关系统提示词中间件
//
// 上游：https://github.com/YaoGuaiLi/hangong （MIT）
// 本仓库为 fork 重构版：改名 poxian，重写握手/过滤/幂等，补 Anthropic 缓存断点。
//
// 作用：把工作台系统提示词写进每一个经过 magpie 网关的请求，落在各协议
// 自己的 system 位置：
//   anthropic.system · chat.messages[system] · responses.instructions ·
//   gemini.systemInstruction / system_instruction
//
// 默认 override + prepend：请求已带 agent 自己的 system prompt 时保留它，
// 把本提示词放在最前（最高优先级），且合并后的前缀字节稳定，不破坏缓存。
//
// prompt 选择（先命中先赢）：
//   options.on_prompt   字面文本，优先级最高
//   options.prompt      版本 id（v52/v5/v4/v3），未知 id 回落默认（v5）
//   （其余）             默认版本 v52
//
// 激活词轻路由：末条用户消息恰好是 寒霜 / 自检 / SELF-CHECK 时，只注入几行
// 握手指令而不是整份 prompt；配 options.handshake_model 可把握手请求改派到
// 便宜模型。握手保留对话历史，只替换 system。
//
// 过滤：agents_off 排除；agents 白名单，命中则优先于 agents_off；models 按
// 模型名前缀过滤。过滤器先于握手判定，显式排除的 agent 不会被握手绕过。
//
// options（`magpie plugin options poxian '<json>'` 或控制台页面）：
//   {"enabled": false}          总闸关闭，什么都不做
//   {"prompt": "v4"}            选版本
//   {"on_prompt": "..."}        用这段字面文本
//   {"override": false}         已有 system prompt 的请求直接跳过
//   {"position": "append"}      放在 agent 自己的 prompt 之后
//   {"agents_off": ["codex"]}   这些 agent 不注入
//   {"agents": ["claude"]}      只给这些 agent 注入（覆盖 agents_off）
//   {"models": ["glm-"]}        只给这些模型前缀注入
//   {"handshake": false}        关掉激活词握手
//   {"handshake_model": "x/y"}  握手请求改派到该模型
//   {"cache": false}            关掉 Anthropic cache_control 断点

import { PROMPT, VERSIONS, DEFAULT_VERSION } from "./poxian-prompt.js"

const ACTIVATION = ["寒霜", "自检", "SELF-CHECK"] // moejs: Set.has 对 CJK 有坑，用 indexOf

// 幂等标记：注入内容首行。已带标记的请求不再二次注入。
const MARK = "<!--poxian-->"

const HANDSHAKE_PROMPT = [
  "You are the poxian workbench kernel. The user's message is an exact activation word, not a task.",
  "- If the message is exactly 寒霜: reply with exactly this one line and nothing else:",
  "  寒霜 ready · 主内核已加载 · 红蓝双档待命 · 给目标或场景",
  "- If the message is exactly 自检 or SELF-CHECK: reply with exactly: 全系统正常。继续。",
  "Never use tools; never add commentary; reply with the fixed line only.",
].join("\n")

const CACHE = { type: "ephemeral" }

// 预计算：注入文本按版本算一次，请求路径上不再为 78K 文本做字符串拼接。
// 同时保证同一版本每次注入的是同一个字符串对象——V8 可复用，前缀对缓存更稳定。
const HANDSHAKE_TEXT = MARK + "\n" + HANDSHAKE_PROMPT
const MARKED = {}
MARKED[DEFAULT_VERSION] = MARK + "\n" + PROMPT
for (const id of Object.keys(VERSIONS)) MARKED[id] = MARK + "\n" + VERSIONS[id].text

/* ================= 通用小工具（协议间共用的唯一实现） ================= */

// "prompt\nown" 或 "own\nprompt"——三个字符串注入点共用
function joint(prompt, own, before) {
  return before ? prompt + "\n" + own : own + "\n" + prompt
}

// 仅用于 Anthropic system：字符串或块数组都视为空
function isEmptySystem(s) {
  return s === undefined || s === null || s === "" || (Array.isArray(s) && s.length === 0)
}

// gemini 字段名：snake_case 优先（握手与注入两处共用）
function geminiKey(body) {
  return body.system_instruction && !body.systemInstruction ? "system_instruction" : "systemInstruction"
}

// 首条 system / developer 的索引，没有返回 -1（幂等检查、chat 注入、握手三处共用）
function systemIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m && (m.role === "system" || m.role === "developer")) return i
  }
  return -1
}

// 块数组前置/后置插入——anthropic / chat / gemini 三处共用
function insertBlock(arr, item, before) {
  if (before) arr.unshift(item)
  else arr.push(item)
}

/* ================= 文本读取 ================= */

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    let s = ""
    for (let i = 0; i < content.length; i++) {
      const p = content[i]
      if (p && typeof p === "object" && typeof p.text === "string") s += p.text
    }
    return s
  }
  return ""
}

// 逐块 indexOf + 命中即返回：避免为 78K system prompt 构造临时字符串。
// 接受字符串、块数组、以及 {parts:[...]} 三种形状。
function markIn(content) {
  if (typeof content === "string") return content.indexOf(MARK) !== -1
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const p = content[i]
      if (p && typeof p === "object" && typeof p.text === "string" && p.text.indexOf(MARK) !== -1) return true
    }
    return false
  }
  if (content && typeof content === "object" && Array.isArray(content.parts)) return markIn(content.parts)
  return false
}

function hasMark(body, protocol) {
  if (protocol === "anthropic") return markIn(body.system)
  if (protocol === "chat") {
    const i = systemIndex(body.messages)
    return i !== -1 && markIn(body.messages[i].content)
  }
  if (protocol === "responses") return typeof body.instructions === "string" && body.instructions.indexOf(MARK) !== -1
  if (protocol === "gemini") {
    const s = body[geminiKey(body)]
    return s ? markIn(s) : false
  }
  return false
}

/* ================= 激活词 ================= */

function lastUserText(body, protocol) {
  // Responses API 允许 input 是裸字符串
  if (protocol === "responses" && typeof body.input === "string") return body.input

  // gemini 用 contents[].parts[]，形状与其它协议不同
  if (protocol === "gemini") {
    if (!Array.isArray(body.contents)) return ""
    for (let i = body.contents.length - 1; i >= 0; i--) {
      const c = body.contents[i]
      if (!c || (c.role !== "user" && c.role !== undefined) || !Array.isArray(c.parts)) continue
      let out = ""
      for (let j = 0; j < c.parts.length; j++) {
        const p = c.parts[j]
        out += p && typeof p.text === "string" ? p.text : ""
      }
      return out
    }
    return ""
  }

  // anthropic / chat 用 body.messages，responses 用 body.input——同一套倒序扫描
  const list = protocol === "responses" ? body.input : body.messages
  if (!Array.isArray(list)) return ""
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.role === "user") return textOf(m.content)
  }
  return ""
}

function isHandshake(body, protocol) {
  const t = String(lastUserText(body, protocol) || "").trim()
  return ACTIVATION.indexOf(t) !== -1
}

/* ================= 注入：各协议一个纯函数 ================= */

// 命中上限立即返回：长对话不必扫完整棵 messages
function hasCacheRoom(body, limit) {
  let n = 0
  if (Array.isArray(body.system)) {
    for (const b of body.system) if (b && b.cache_control) { if (++n >= limit) return false }
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || !Array.isArray(m.content)) continue
      for (const b of m.content) if (b && b.cache_control) { if (++n >= limit) return false }
    }
  }
  return true
}

function anthropic(body, prompt, over, before, cache) {
  const s = body.system
  if (isEmptySystem(s)) {
    body.system = cache ? [{ type: "text", text: prompt, cache_control: CACHE }] : prompt
    return body
  }
  if (!over) return

  // Anthropic 最多 4 个 cache 断点，已有 4 个就不再争加
  const useCache = cache && hasCacheRoom(body, 4)

  if (typeof s === "string") {
    body.system = useCache
      ? (before
        ? [{ type: "text", text: prompt, cache_control: CACHE }, { type: "text", text: s }]
        : [{ type: "text", text: s }, { type: "text", text: prompt, cache_control: CACHE }])
      : joint(prompt, s, before)
  } else if (Array.isArray(s)) {
    const block = { type: "text", text: prompt }
    if (useCache) block.cache_control = CACHE
    insertBlock(s, block, before)
  } else return
  return body
}

function chat(body, prompt, over, before) {
  const idx = systemIndex(body.messages)
  if (idx === -1) {
    // 没有 system：插入一条（此处不受 override 约束，测试用例如此约定）
    body.messages.unshift({ role: "system", content: prompt })
    return body
  }
  if (!over) return
  const first = body.messages[idx]
  if (typeof first.content === "string") first.content = joint(prompt, first.content, before)
  else if (Array.isArray(first.content)) insertBlock(first.content, { type: "text", text: prompt }, before)
  else return
  return body
}

function responses(body, prompt, over, before) {
  const s = body.instructions
  if (typeof s !== "string" || !s) {
    body.instructions = prompt
    return body
  }
  if (!over) return
  body.instructions = joint(prompt, s, before)
  return body
}

function gemini(body, prompt, over, before) {
  const key = geminiKey(body)
  const s = body[key]
  if (!s || !Array.isArray(s.parts) || !s.parts.length) {
    // 纯字符串或缺失：整段换成 parts 形式；原字符串保留为一侧
    const keep = typeof s === "string" && s ? s : ""
    const parts = []
    if (before && keep) parts.push({ text: prompt }, { text: keep })
    else if (before) parts.push({ text: prompt })
    else if (keep) parts.push({ text: keep }, { text: prompt })
    else parts.push({ text: prompt })
    body[key] = { parts }
    return body
  }
  if (!over) return
  insertBlock(s.parts, { text: prompt }, before)
  return body
}

/* ================= 选择 prompt ================= */

function pickPrompt(o) {
  if (typeof o.on_prompt === "string" && o.on_prompt) return MARK + "\n" + o.on_prompt
  const id = o.prompt
  if (typeof id === "string" && id && Object.prototype.hasOwnProperty.call(MARKED, id)) return MARKED[id]
  return MARKED[DEFAULT_VERSION]
}

/* ================= 入口 ================= */

// 握手：只替换 system，保留对话历史；四协议同一套定位逻辑
function handshake(body, proto, text, o) {
  if (typeof o.handshake_model === "string" && o.handshake_model) body.model = o.handshake_model
  if (proto === "anthropic") {
    body.system = text
    return body
  }
  if (proto === "chat") {
    if (!Array.isArray(body.messages)) return
    const i = systemIndex(body.messages)
    if (i !== -1) body.messages[i].content = text
    else body.messages.unshift({ role: "system", content: text })
    return body
  }
  if (proto === "responses") {
    body.instructions = text
    return body
  }
  if (proto === "gemini") {
    body[geminiKey(body)] = { parts: [{ text }] }
    return body
  }
}

function handle(body, ctx) {
  if (!body || typeof body !== "object") return
  const o = ctx.options || {}
  if (o.enabled === false) return

  const proto = ctx.protocol

  // 1) 过滤先于握手：显式排除的 agent 不该被握手绕过
  if (Array.isArray(o.agents_off) && o.agents_off.length && o.agents_off.indexOf(ctx.agent) !== -1) return
  if (Array.isArray(o.agents) && o.agents.length && o.agents.indexOf(ctx.agent) === -1) return
  if (Array.isArray(o.models) && o.models.length) {
    const model = String(body.model || ctx.model || "")
    if (!o.models.some((m) => typeof m === "string" && model.startsWith(m))) return
  }

  // 2) 幂等：已注入过就不再叠
  if (hasMark(body, proto)) return

  // 3) 握手
  if (o.handshake !== false && isHandshake(body, proto)) return handshake(body, proto, HANDSHAKE_TEXT, o)

  // 4) 正常注入
  const prompt = pickPrompt(o)
  const before = o.position !== "append"
  const over = o.override !== false
  const cache = o.cache !== false

  switch (proto) {
    case "anthropic":
      return anthropic(body, prompt, over, before, cache)
    case "chat":
      return chat(body, prompt, over, before)
    case "responses":
      return responses(body, prompt, over, before)
    case "gemini":
      return gemini(body, prompt, over, before)
  }
}

export function onRequest(body, ctx) {
  try {
    return handle(body, ctx)
  } catch (e) {
    // 中间件绝不把异常抛回网关：一个畸形请求不该打挂整条链路
    return
  }
}
