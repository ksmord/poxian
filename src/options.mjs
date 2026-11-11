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
  o.cache = o.cache === true
  o.handshake = o.handshake !== false
  o.strip_frontmatter = o.strip_frontmatter !== false
  o.log = o.log !== false

  o.skip_stream = o.skip_stream === true
  o.dry_run = o.dry_run === true

  o.models = toList(o.models)
  o.agents = toList(o.agents)
  o.agents_off = toList(o.agents_off)
  o.prompt_allowlist = toList(o.prompt_allowlist).map(str).filter(Boolean)

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

function toList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x).map((x) => x.trim())
  if (typeof v === "string" && v.trim()) return v.split(",").map((x) => x.trim()).filter(Boolean)
  return []
}
