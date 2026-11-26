// 注入清单（manifest）：回答「这一次请求到底被改了什么」，可事后对账。
//
// ── 为什么要独立一层 ────────────────────────────────────────────────
// 观测层（observe.mjs）记的是「发生了什么动作」，契约是失败即吞；
// 清单层要记的是「这一次改写的内容指纹」，契约是**不能吞**——它的用途是复核：
//   · 载荷换了没（promptSha256 变没变）
//   · 落点对不对（协议 + 位置 + 是否整段替换）
//   · 真实改了哪些字节（written_bytes / 是否逐字透传）
// 两件事混在一起时，日志一多就看不出「哪一轮用的是哪一版载荷」。
//
// ── 为什么哈希要带规范化 ────────────────────────────────────────────
// 同一份 md 在不同机器上会因为 CRLF / BOM / 尾随空白算出不同的 sha256，
// 那样指纹就失去了「同一份载荷」的判定力。这里先做最小规范化再做哈希：
//   1. 去掉 BOM
//   2. CRLF / CR 统一成 LF
//   3. 去掉行尾空白
//   4. 去掉末尾多余的换行
// 规范化是**只用于算指纹**的，写进请求的正文永远是原文（不做任何改写）。
// 这条边界必须守住：规范化一旦渗进写入路径，就变成「悄悄改了用户载荷」。

// ── 为什么 createHash 不在顶层 import ──────────────────────────────
// magpie 中间件引擎（bundle 模式）只允许 import 同目录文件，`node:crypto` 会被拒
// → 「cannot resolve module "node:crypto"」使整个中间件加载失败（calls 恒 0）。
//
// 但这里**不能**像 nonce 那样退化成非密码学哈希：promptSha256 是审计锚，
// 用它回答「这一次请求到底被改了哪一版载荷」。拿一个 FNV 之类的近似值冒充 sha256，
// 等于伪造审计证据——那比「没有指纹」危险得多。
//
// 所以策略是：能拿到 crypto → 真 sha256；拿不到 → 返回空串。
// 空串在下游一律读作「本次未审计」，是诚实的缺省，不是伪造的值。
let _createHash = null
try {
  const req = typeof require === "function" ? require : null
  if (req) _createHash = req("node:crypto").createHash
} catch {}

/** 当前环境能否算 sha256。设置页可以据此显示「审计可用/不可用」。 */
export function shaAvailable() {
  return _createHash !== null
}

/** 计算载荷指纹。传入原始文本，返回 16 位十六进制；无 crypto 时返回空串（=未审计）。 */
export function promptSha256(text) {
  if (!_createHash) return ""
  const t = typeof text === "string" ? text : ""
  const norm = t
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "")
  return _createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16)
}

/** 字节长度的快速估算：不需要 Buffer 的场合用它，避免为了打日志多分配一次。 */
export function byteLen(text) {
  if (typeof text !== "string") return 0
  // UTF-8 下 ASCII 1 字节、CJK 3 字节、代理对 4 字节。这里只用于日志，
  // 允许用便宜的近似：先把非 ASCII 计 3，再对代理对补 1。
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/**
 * 生成一次注入的清单条目。
 *
 * @param {object} p
 * @param {string} p.protocol     协议 id（chat / anthropic / responses / gemini）
 * @param {string} p.mode         replace / merge / handshake / prefill-only
 * @param {string} p.position     prepend / append / replace
 * @param {string} p.tier         full / skeleton / none
 * @param {string} p.source       载荷来源（builtin / file / literal）
 * @param {string} p.text         实际写入的正文
 * @param {string} [p.path]       外部载荷路径
 * @param {boolean} [p.filtered]  是否做过报文清洗
 * @param {boolean} [p.prefill]   是否加了预填
 * @param {boolean} [p.echo]      是否加了回显探针
 */
export function buildManifest(p) {
  const m = p || {}
  const text = typeof m.text === "string" ? m.text : ""
  return {
    manifest: 1,
    protocol: m.protocol || null,
    mode: m.mode || null,
    position: m.position || null,
    tier: m.tier || null,
    src: m.source || null,
    path: m.path || null,
    // 指纹只对正文算，不含 MARK —— 否则同一份载荷因为标记变体算出两个值。
    promptSha256: promptSha256(text),
    chars: text.length,
    bytes: byteLen(text),
    ...(m.filtered ? { filtered: true } : {}),
    ...(m.prefill ? { prefill: true } : {}),
    ...(m.echo ? { echo: true } : {}),
  }
}

/**
 * 逐字透传自证：同一个请求在 off / 未命中时的输出必须与输入**逐字节相同**。
 *
 * 这条自证是整层可信度的地基。没有它，「关掉注入」只是一句承诺：
 * 任何一处 clone / 归一 / 排序都可能悄悄改掉请求体，而用户看不见。
 * 做法是最笨也最可靠的：JSON 序列化前后各算一次 sha256，比对是否相等。
 *
 * 注意：只对 body 的 JSON 表示做比对。magpie 钩子拿到的就是解析后的对象，
 * 上游收到的是网关自己再序列化的结果，所以这里比的是「本插件有没有动它」，
 * 而不是「上游最终收到什么字节」——后者不在本插件的可见范围内。
 *
 * @returns {{identical:boolean, before:string, after:string, changedKeys:string[]}}
 */
export function verifyPassthrough(before, after) {
  const s1 = safeStringify(before)
  const s2 = safeStringify(after)
  // 判等永远走原文比较（s1 === s2），不依赖哈希——
  // 所以即使无 crypto，identical 的结论依然可靠，只有展示用指纹退化为空串。
  const digest = (s) => (_createHash ? _createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16) : "")
  return {
    identical: s1 === s2,
    before: digest(s1),
    after: digest(s2),
    changedKeys: s1 === s2 ? [] : diffTopKeys(before, after),
  }
}

// 顶层键的差集：只到第一层，够定位「是 system 被动了还是 messages 被动了」。
// 深比对在排障时没有额外价值，反而让输出难以阅读。
function diffTopKeys(a, b) {
  const ka = a && typeof a === "object" ? Object.keys(a) : []
  const kb = b && typeof b === "object" ? Object.keys(b) : []
  const out = []
  for (const k of new Set([...ka, ...kb])) {
    const va = a ? a[k] : undefined
    const vb = b ? b[k] : undefined
    if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(k)
  }
  return out
}

// 稳定序列化：键序固定，避免同一对象两次序列化得到不同字符串（JSON.stringify 保序，
// 但调用方可能在两次之间重建过对象，键顺序变了会误报「不逐字」）。
function safeStringify(v) {
  try {
    return stable(v)
  } catch {
    return "<unstringifiable>"
  }
}

function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]"
  const keys = Object.keys(v).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}"
}