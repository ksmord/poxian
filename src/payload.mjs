// payload 解析：外部文件优先级最高，每请求 stat，文件真变了才重新解码。
// 这里持有 node:fs，只有异步钩子入口可以 import。

import { readFile, stat } from "node:fs/promises"
import { relative, isAbsolute } from "node:path"
import { MARK, HANDSHAKE_TEXT } from "./constants.mjs"
import { expandPath } from "./options.mjs"
import { PROMPT, VERSIONS, DEFAULT_VERSION } from "../poxian-prompt.js"

const MAX_CACHE = 8
const cache = new Map() // key -> text

// 解码：BOM / UTF-16 / 无 BOM 的 UTF-16 / CRLF 全处理。
// 中文 Windows 编辑器存出来的 .md 常带 BOM，直接按 UTF-8 读会多出一个 \uFEFF。
function decode(buf) {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le")
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      const swapped = Buffer.from(buf.subarray(2))
      swapped.swap16()
      return swapped.toString("utf16le")
    }
  }
  if (looksUtf16(buf)) {
    return buf[0] === 0 ? swapAndDecode(buf) : buf.toString("utf16le")
  }
  return buf.toString("utf8")
}

// 无 BOM 的 UTF-16：ASCII 字符的高字节是 0，按位置统计能判出来。
function looksUtf16(buf) {
  const n = Math.min(buf.length, 512)
  if (n < 8) return false
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < n; i++) {
    if (buf[i] !== 0) continue
    if (i % 2 === 0) evenZero++
    else oddZero++
  }
  const half = n / 2
  return oddZero > half * 0.6 || evenZero > half * 0.6
}

function swapAndDecode(buf) {
  const swapped = Buffer.from(buf)
  if (swapped.length % 2 === 1) return swapped.toString("utf8")
  swapped.swap16()
  return swapped.toString("utf16le")
}

const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/

function clean(text, stripFrontmatter) {
  let t = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  if (stripFrontmatter) t = t.replace(FRONTMATTER, "")
  return t.trim()
}

async function loadFile(path, stripFrontmatter = true) {
  const st = await stat(path)
  const key = path + "\u0000" + st.mtimeMs + "\u0000" + st.size + "\u0000" + (stripFrontmatter ? 1 : 0)

  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const text = clean(decode(await readFile(path)), stripFrontmatter)
  cache.set(key, text)
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  return text
}

// 内置版本表：MARK + 正文，与原实现 MARKED 同构。
function bundled() {
  const out = Object.create(null)
  for (const id of Object.keys(VERSIONS)) out[id] = MARK + "\n" + VERSIONS[id].text
  out[DEFAULT_VERSION] = MARK + "\n" + PROMPT
  return out
}

let BUNDLED = null

function pickBundled(id) {
  if (!BUNDLED) BUNDLED = bundled()
  if (id && BUNDLED[id]) return { text: BUNDLED[id], source: "bundle:" + id }
  return { text: BUNDLED[DEFAULT_VERSION], source: "bundle:" + DEFAULT_VERSION }
}

// 优先级：on_prompt（字面） > prompt_path（文件） > prompt（版本 id） > 默认版本
// 文件读失败不阻断请求：记 fallback，退回内置版本。
export async function resolvePrompt(o, ctx) {
  return applyLimit(await resolveRaw(o, ctx), o)
}

async function resolveRaw(o, ctx) {
  if (o.on_prompt) return { text: MARK + "\n" + o.on_prompt, source: "literal" }

  if (o.prompt_path) {
    const path = expandPath(o.prompt_path, ctx)
    if (blocked(path, o, ctx)) {
      return { ...pickBundled(o.prompt), source: "fallback:path-blocked", path_blocked: true }
    }
    try {
      const text = await loadFile(path, o.strip_frontmatter)
      if (text) return { text: MARK + "\n" + text, source: "file:" + path }
      return { ...pickBundled(o.prompt), source: "fallback:empty" }
    } catch (e) {
      return { ...pickBundled(o.prompt), source: "fallback:" + (e && e.code ? e.code : "err") }
    }
  }

  const b = pickBundled(o.prompt)
  return { text: b.text, source: b.source }
}

// 载荷字节上限：超限就降级回内置版本，并打上 oversize 标记供日志报警。
// max_payload_bytes = 0 时不限制，行为与旧版完全一致。
function applyLimit(r, o) {
  const bytes = Buffer.byteLength(r.text, "utf8")
  const max = o.max_payload_bytes || 0
  if (!max || bytes <= max) return { ...r, bytes }

  const b = pickBundled(o.prompt)
  return {
    text: b.text,
    source: "fallback:oversize",
    oversize: true,
    bytes: Buffer.byteLength(b.text, "utf8"),
    requested_bytes: bytes,
  }
}

// 目录白名单：空列表 = 不限制（保持旧行为）。
// 比较用 path.relative 判越界，不用 startsWith（前缀兄弟目录会绕过）。
// 已知限制：不做 realpath，符号链接绕行拦不住；Windows 大小写已归一。
function blocked(target, o, ctx) {
  const roots = o.prompt_allowlist
  if (!roots || !roots.length) return false

  const t = norm(target)
  return !roots.some((root) => {
    const r = norm(expandPath(root, ctx))
    if (!r) return false
    const rel = relative(r, t)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  })
}

function norm(p) {
  let s = String(p || "")
  if (!s) return ""
  if (process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(s)) s = s.toLowerCase()
  return s
}

export function handshakeText() {
  return MARK + "\n" + HANDSHAKE_TEXT
}

// 测试用：清掉 mtime 缓存
export function _resetCache() {
  cache.clear()
}
