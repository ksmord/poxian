// 选项归一 + 路径展开。
//
// ── 为什么这里不能有顶层 node:os / node:path ────────────────────────
// magpie 的中间件引擎（bundle 模式）有硬约束：
//   cannot resolve module "node:os": a middleware imports only files beside it;
//   bundle packages into it
// 也就是说中间件只能 import 同目录的文件和引擎自带的东西，`node:os` / `node:path`
// 在 bundle 阶段就会被拒。而 `poxian.middleware.js`（同步壳）与本文件同属那条链，
// 一旦顶层写死 `import { homedir } from "node:os"`，整个中间件加载失败：
// 界面上就是「中间件没有加载」，calls 恒为 0。
//
// 所以改成**惰性**：只有真正调用 expandPath()（需要 ~ 展开）时才去拿这两个模块，
// 且用 try/catch 兜住——bundle 环境下拿不到就退化成「不展开 ~」，
// 而不是让整个中间件加载失败。normalize() 完全不碰它们。

import { DEFAULTS } from "./constants.mjs"

const WIN_ABS = /^[A-Za-z]:[\\/]/
const UNC_ABS = /^\\\\[^\\]/
const POSIX_ABS = /^\//
// 静态字面量，便于 bundle：能求值就用，不能就留空。
// node 原生环境下这两个变量有值；bundle 环境下为空，expandPath 会退化成不展开 ~。
let _homedir = ""
let _resolve = null
try {
  // 用 createRequire 而不是 import 语句：import 会被 bundle 静态分析拦下，
  // require 是运行时求值，加载期不触发解析。
  const req = typeof require === "function" ? require : null
  if (req) {
    _homedir = req("node:os").homedir()
    _resolve = req("node:path").resolve
  }
} catch {}

function homedir() {
  if (_homedir) return _homedir
  // 退化路径：环境变量里通常有 HOME / USERPROFILE，够 expandPath 用了。
  const h = (typeof process !== "undefined" && process.env && (process.env.HOME || process.env.USERPROFILE)) || ""
  _homedir = h
  return h
}

function resolvePath(a, b) {
  if (_resolve) return _resolve(a, b)
  // 退化路径：手工拼。只在 bundle 且又用了相对路径时走到这里。
  const sep = a.includes("\\") && !a.includes("/") ? "\\" : "/"
  if (b === undefined) return a
  return a.replace(/[\\/]+$/, "") + sep + String(b).replace(/^[\\/]+/, "")
}

// 布尔归一。
//
// 旧写法一律是 `x !== false`，这会把页面/旧配置写回的字符串 "false" 归一成 **true**——
// 表现为「在设置页关了注入，请求照样被改写」，而且日志里 enabled 看着是对的。
// 注入中间件关不掉是最严重的一类故障，所以这里把布尔来源全部收口到一个函数：
//   false / 0 / "false" / "0" / "off" / "no" → 关
//   true  / 1 / "true"  / "1" / "on"  / "yes" → 开
//   认不出的值 → 回落到调用方给的默认值（不做「非真即假」的猜测）
function bool(v, d) {
  if (v === false || v === 0) return false
  if (v === true || v === 1) return true
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (s === "false" || s === "0" || s === "off" || s === "no" || s === "") return false
    if (s === "true" || s === "1" || s === "on" || s === "yes") return true
  }
  return d
}

// 归一：只做类型校正，不做语义判断。
export function normalize(raw) {
  const o = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) }

  o.enabled = bool(o.enabled, true)
  o.override = bool(o.override, true)
  o.position = o.position === "append" ? "append" : "prepend"
  // 只有显式写 merge 才回退旧拼接行为，其余一律整段替换。
  // 理由见 core.mjs 的 override_mode 分支：拼接在实机 A/B 里从未让注入生效。
  o.override_mode = o.override_mode === "merge" ? "merge" : "replace"
  o.cache = bool(o.cache, true)
  o.handshake = bool(o.handshake, true)
  o.strip_frontmatter = bool(o.strip_frontmatter, true)
  o.log = bool(o.log, true)

  o.skip_stream = bool(o.skip_stream, false)
  o.dry_run = bool(o.dry_run, false)

  // ========== 新增报文清洗相关布尔归一 ==========
  o.enable_message_filter = bool(o.enable_message_filter, false)
  o.strip_safety_system = bool(o.strip_safety_system, true)
  o.strip_deny_assistant = bool(o.strip_deny_assistant, false)
  // ============================================

  // 探针：两个独立开关，默认都关（echo 会改请求体，不该默默生效）
  o.probe_echo = bool(o.probe_echo, false)
  // 回显落点：只有显式写 payload 才回退旧行为（进 system 尾巴）。
  // 旧行为每请求在 system 里换一个 nonce，上游前缀缓存从 nonce 处断链，
  // 实测把 workbuddy 的 79.4% 打到 1.3%——所以默认值必须是 message。
  o.probe_echo_position = o.probe_echo_position === "payload" ? "payload" : "message"
  o.probe_refusal = bool(o.probe_refusal, false)

  // 预填：空字符串 = 关。prefill_models 为空 = 全路由生效，
  // 但会写进报文，所以默认值是空字符串而不是一个默认前缀。
  o.prefill = str(o.prefill)
  o.prefill_models = toList(o.prefill_models)
  o.prefill_auto = bool(o.prefill_auto, true)

  o.models = toList(o.models)
  o.agents = toList(o.agents)
  o.agents_off = toList(o.agents_off)
  o.prompt_allowlist = toList(o.prompt_allowlist).map(str).filter(Boolean)

  // ============ 注入档位 ============
  // 只认三个值，写错一律回 always——档位是省钱开关，猜错方向的代价是人格消失。
  o.inject_mode = o.inject_mode === "tiered" || o.inject_mode === "on_refusal" || o.inject_mode === "off"
    ? o.inject_mode
    : "always"
  o.skeleton_prompt = str(o.skeleton_prompt)
  o.skeleton_path = str(o.skeleton_path)
  o.refusal_ttl_ms = num(o.refusal_ttl_ms, 300000)
  o.latch_max = num(o.latch_max, 512)
  o.risk_preempt = bool(o.risk_preempt, true)
  o.tier_full_every = num(o.tier_full_every, 0)

  // 路由适配：fallback 落 false。它会覆盖用户手配的 prompt，
  // 认不出的值必须当「关」，否则一个拼错的 "yes" 就能悄悄换掉载荷。
  o.route_adapt = bool(o.route_adapt, false)

  const backup = Number(o.log_backup_count)
  o.log_backup_count =
    Number.isInteger(backup) && backup > 0 ? Math.min(backup, 9) : DEFAULTS.log_backup_count

  const max = Number(o.max_payload_bytes)
  o.max_payload_bytes = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0

  o.prompt = str(o.prompt)
  o.prompt_path = str(o.prompt_path)
  o.on_prompt = str(o.on_prompt)
  o.handshake_model = str(o.handshake_model)
  o.log_path = str(o.log_path) || DEFAULTS.log_path

  const t = Number(o.gatewayTimeoutMs)
  o.gatewayTimeoutMs = Number.isFinite(t) && t > 0 ? t : DEFAULTS.gatewayTimeoutMs

  return o
}

// 展开 ~、$VAR、${VAR}、%VAR%，相对路径对 ctx.cwd 解析。
// 跨平台绝对路径（Windows 盘符 / UNC / POSIX）原样返回，不在错误平台上改写成垃圾。
export function expandPath(p, ctx) {
  let s = str(p)
  if (!s) return ""

  s = s
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => env(n) ?? m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => env(n) ?? m)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => env(n) ?? m)

  if (s === "~") s = homedir()
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = resolvePath(homedir(), s.slice(2))

  if (WIN_ABS.test(s) || UNC_ABS.test(s) || POSIX_ABS.test(s)) return s

  const base = ctx && typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd()
  return resolvePath(base, s)
}

function env(n) {
  const v = process.env[n]
  return typeof v === "string" && v ? v : null
}

function str(v) {
  return typeof v === "string" ? v.trim() : ""
}

// 数值兜底：写坏了就回默认，不把 NaN 传进策略里。
function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

function toList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x).map((x) => x.trim())
  if (typeof v === "string" && v.trim()) return v.split(",").map((x) => x.trim()).filter(Boolean)
  return []
}

// 非破坏性写 + 陌生键告警。
// options.set 是整份替换，另一版本写进来的键会被旧页面一保存抹掉且界面毫无提示。
export const KNOWN_OPTION_KEYS = new Set(Object.keys(DEFAULTS))
export function detectUnknownOptionKeys(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  return Object.keys(raw).filter((k) => !KNOWN_OPTION_KEYS.has(k))
}
export function mergeForWrite(base, patch) {
  const out = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) }
  for (const [k, v] of Object.entries(patch || {})) if (KNOWN_OPTION_KEYS.has(k)) out[k] = v
  return out
}