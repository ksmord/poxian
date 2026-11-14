// 选项归一 + 路径展开。
// 只用 node:os / node:path，不碰 fs——同步中间件壳也要能 import。

import { homedir } from "node:os"
import { resolve } from "node:path"
import { DEFAULTS } from "./constants.mjs"

const WIN_ABS = /^[A-Za-z]:[\\/]/
const UNC_ABS = /^\\\\[^\\]/
const POSIX_ABS = /^\//

// 归一：只做类型校正，不做语义判断。
export function normalize(raw) {
  const o = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) }

  o.enabled = o.enabled !== false
  o.override = o.override !== false
  o.position = o.position === "append" ? "append" : "prepend"
  // 只有显式写 merge 才回退旧拼接行为，其余一律整段替换。
  // 理由见 core.mjs 的 override_mode 分支：拼接在实机 A/B 里从未让注入生效。
  o.override_mode = o.override_mode === "merge" ? "merge" : "replace"
  o.cache = o.cache === true
  o.handshake = o.handshake !== false
  o.strip_frontmatter = o.strip_frontmatter !== false
  o.log = o.log !== false

  o.skip_stream = o.skip_stream === true
  o.dry_run = o.dry_run === true

  // ========== 新增报文清洗相关布尔归一 ==========
  o.enable_message_filter = o.enable_message_filter === true
  o.strip_safety_system = o.strip_safety_system !== false
  o.strip_deny_assistant = o.strip_deny_assistant === true
  // ============================================

  // 探针：两个独立开关，默认都关（echo 会改请求体，不该默默生效）
  o.probe_echo = o.probe_echo === true
  // 回显落点：只有显式写 payload 才回退旧行为（进 system 尾巴）。
  // 旧行为每请求在 system 里换一个 nonce，上游前缀缓存从 nonce 处断链，
  // 实测把 workbuddy 的 79.4% 打到 1.3%——所以默认值必须是 message。
  o.probe_echo_position = o.probe_echo_position === "payload" ? "payload" : "message"
  o.probe_refusal = o.probe_refusal === true

  // 预填：空字符串 = 关。prefill_models 为空 = 全路由生效，
  // 但会写进报文，所以默认值是空字符串而不是一个默认前缀。
  o.prefill = str(o.prefill)
  o.prefill_models = toList(o.prefill_models)
  o.prefill_auto = o.prefill_auto !== false

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
  o.risk_preempt = o.risk_preempt !== false
  o.tier_full_every = num(o.tier_full_every, 0)

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
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = resolve(homedir(), s.slice(2))

  if (WIN_ABS.test(s) || UNC_ABS.test(s) || POSIX_ABS.test(s)) return s

  const base = ctx && typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd()
  return resolve(base, s)
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
