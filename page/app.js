// poxian 控制台 —— 零依赖。桥接 API（_magpie/bridge.js）：
//   await magpie.ready            { dark, lang, tokens }
//   await magpie.options.get()    本插件当前配置
//   await magpie.options.set(o)   写回并持久化，返回写后的值
//
// 版本元数据来自 versions.js（构建产物，window.PX_VERSIONS）。
//
// 表单字段由 SCHEMA 声明：加一个选项只改 SCHEMA 一行 + index.html 一行，
// 读表单 / 写表单 / 脏检测三处自动跟随，不再各自维护字段清单。

const VERSION = "0.0.1"

const AGENTS = window.HG_AGENTS || []
const VERSIONS = window.PX_VERSIONS || []
const DEFAULT_VERSION = window.PX_DEFAULT_VERSION || "v5"

// 选中态本地镜像：桥接读不到 / 超时也不会丢选择
const LS_KEY = "poxian.ver.v1"

const $ = (id) => document.getElementById(id)

/* ================= 字段声明（唯一真相） =================
   kind:
     bool   — 开关按钮，默认 true；OFF 时写入 false
     seg    — 分段单选，默认 "prepend"；非默认时写入选中值
     text   — 文本输入，默认 ""；非空时写入
     list   — 逗号分隔列表，默认 []；非空时写入
     ver    — 版本选择器（.prow[data-ver]），默认 DEFAULT_VERSION
     prompt — 自定义提示词（.prow[data-ver="custom"]），选中且非空时写入 on_prompt
*/
const SCHEMA = [
  { key: "enabled",   kind: "bool", el: "en", def: true },
  { key: "override",  kind: "bool", el: "ov", def: true },
  { key: "position",  kind: "seg",  el: "posSeg", name: "pos", def: "prepend" },
  { key: "cache",     kind: "bool", el: "ce", def: true },
  { key: "handshake", kind: "bool", el: "hs", def: true },
  { key: "handshake_model", kind: "text", el: "hm", def: "" },
  { key: "models",    kind: "list", el: "md", def: [] },
  { key: "prompt",    kind: "ver",  def: DEFAULT_VERSION },
  { key: "on_prompt", kind: "prompt", el: "op", def: "" },
]

/* ---------- 小工具 ---------- */
function toast(text, kind = "", ms = 2400) {
  const t = $("toast")
  t.textContent = text
  t.className = "toast show " + kind
  clearTimeout(toast._h)
  toast._h = setTimeout(() => (t.className = "toast"), ms)
}

// 桥接不守时是常态：任何 await 都套上限时，绝不无期限停在“连接中”
function withTimeout(p, ms, label) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || "timeout")), ms)),
  ])
}

const fmt = (n) => Number(n || 0).toLocaleString("en-US")

function readLS() {
  try { return localStorage.getItem(LS_KEY) } catch { return null }
}
function writeLS(v) {
  try { v === null ? localStorage.removeItem(LS_KEY) : localStorage.setItem(LS_KEY, v) } catch {}
}

/* ---------- 动态构建：版本列表 + Agent 行 ---------- */
function buildVersionList() {
  const box = $("verList")
  box.textContent = ""
  for (const v of VERSIONS) {
    const row = document.createElement("div")
    row.className = "prow"
    row.dataset.ver = v.id
    const heavy = (v.tokens || 0) > 8000
    row.innerHTML =
      '<span class="p-mark"></span>' +
      '<div class="p-main">' +
        '<div class="p-name">' + v.label +
          (v.id === DEFAULT_VERSION ? ' <span class="p-badge ok">默认</span>' : '') +
          (v.badge && v.id !== DEFAULT_VERSION ? ' <span class="p-badge">' + v.badge + '</span>' : '') +
        '</div>' +
        '<div class="p-desc">' + v.desc + '</div>' +
      '</div>' +
      '<span class="p-cost' + (heavy ? ' heavy' : '') + '">' +
        fmt(v.chars) + ' 字<br>~' + fmt(v.tokens) + ' tok</span>' +
      '<span class="p-check">✓</span>'
    row.addEventListener("click", () => selectVersion(v.id))
    box.appendChild(row)
  }
  const custom = document.createElement("div")
  custom.className = "prow"
  custom.dataset.ver = "custom"
  custom.innerHTML =
    '<span class="p-mark"></span>' +
    '<div class="p-main">' +
      '<div class="p-name">自定义文本 <span class="p-badge">on_prompt</span></div>' +
      '<div class="p-desc">整段粘贴你自己的系统提示词，优先级最高</div>' +
    '</div><span class="p-check">✓</span>'
  custom.addEventListener("click", () => selectVersion("custom"))
  box.appendChild(custom)
}

function buildAgentList(off) {
  const box = $("agentList")
  box.textContent = ""
  for (const a of AGENTS) {
    const row = document.createElement("div")
    row.className = "arow"
    const on = off.indexOf(a.id) === -1
    row.innerHTML =
      '<div class="a-dot ' + (on ? "ok" : "") + '"></div>' +
      '<div class="a-main"><div class="a-name">' + a.name + ' <span class="a-id">' + a.id + '</span></div>' +
      '<div class="a-note">' + a.note + '</div></div>' +
      '<button class="switch" role="switch" aria-checked="' + on + '" aria-label="' + a.id + '"></button>'
    row.querySelector(".switch").addEventListener("click", (e) => {
      const b = e.currentTarget
      b.setAttribute("aria-checked", b.getAttribute("aria-checked") === "true" ? "false" : "true")
      row.querySelector(".a-dot").classList.toggle("ok", b.getAttribute("aria-checked") === "true")
      sync()
    })
    box.appendChild(row)
  }
}

/* ---------- 表单 ⇄ options（由 SCHEMA 驱动） ---------- */

const isOn = (el) => el.getAttribute("aria-checked") === "true"

function readVersion() {
  const on = document.querySelector(".prow.on")
  return on ? on.dataset.ver : DEFAULT_VERSION
}

function norm(v) {
  return Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []
}
function normOptions(o) {
  const x = o || {}
  const out = {}
  for (const f of SCHEMA) {
    const v = x[f.key]
    if (f.kind === "bool") out[f.key] = v !== false
    else if (f.kind === "seg") out[f.key] = v === "append" ? "append" : "prepend"
    else if (f.kind === "list") out[f.key] = norm(v)
    else if (f.kind === "ver") out[f.key] = typeof v === "string" && v ? v : DEFAULT_VERSION
    else out[f.key] = typeof v === "string" ? v : ""
  }
  out.agents_off = norm(x.agents_off)
  return out
}

function sameOptions(a, b) {
  const A = normOptions(a)
  const B = normOptions(b)
  const keys = Object.keys(A)
  for (let i = 0; i < keys.length; i++) {
    if (JSON.stringify(A[keys[i]]) !== JSON.stringify(B[keys[i]])) return false
  }
  return true
}

function formToOptions() {
  const next = {}
  const agentOff = [...document.querySelectorAll('#agentList .switch[aria-checked="false"]')]
    .map((b) => b.getAttribute("aria-label"))
  if (agentOff.length) next.agents_off = agentOff

  for (const f of SCHEMA) {
    if (f.kind === "bool") {
      if (!isOn($(f.el))) next[f.key] = false
    } else if (f.kind === "seg") {
      const v = document.querySelector('input[name="' + f.name + '"]:checked').value
      if (v !== f.def) next[f.key] = v
    } else if (f.kind === "text") {
      const v = $(f.el).value.trim()
      if (v) next[f.key] = v
    } else if (f.kind === "list") {
      const v = $(f.el).value.split(",").map((s) => s.trim()).filter(Boolean)
      if (v.length) next[f.key] = v
    } else if (f.kind === "ver") {
      const v = readVersion()
      if (v !== "custom" && v !== DEFAULT_VERSION) next.prompt = v
    } else if (f.kind === "prompt") {
      if (readVersion() === "custom" && $(f.el).value.trim()) next.on_prompt = $(f.el).value
    }
  }
  return next
}

function optionsToForm(o) {
  const src = o || {}
  for (const f of SCHEMA) {
    if (f.kind === "bool") {
      $(f.el).setAttribute("aria-checked", src[f.key] !== false ? "true" : "false")
    } else if (f.kind === "seg") {
      const v = src[f.key] === "append" ? "append" : "prepend"
      const input = document.querySelector('input[name="' + f.name + '"][value="' + v + '"]')
      if (input) input.checked = true
    } else if (f.kind === "text") {
      $(f.el).value = typeof src[f.key] === "string" ? src[f.key] : ""
    } else if (f.kind === "list") {
      $(f.el).value = Array.isArray(src[f.key]) ? src[f.key].join(", ") : ""
    }
  }

  buildAgentList(Array.isArray(src.agents_off) ? src.agents_off : [])

  const hasCustom = typeof src.on_prompt === "string" && src.on_prompt
  const ver = hasCustom
    ? "custom"
    : (typeof src.prompt === "string" && VERSIONS.some((v) => v.id === src.prompt) ? src.prompt : DEFAULT_VERSION)

  if (hasCustom) $("op").value = src.on_prompt
  applySelection(ver)
}

function applySelection(ver) {
  const box = $("verList")
  for (const r of box.querySelectorAll(".prow")) r.classList.toggle("on", r.dataset.ver === ver)
  $("opRow").hidden = ver !== "custom"
  sync()
}

/* ---------- 选中即生效 ---------- */
let loaded = {}
let bridgeOk = false

async function selectVersion(ver) {
  applySelection(ver)
  writeLS(ver)

  const next = { ...normOptions(loaded) }
  // 只改提示词相关两个键，其余保持当前生效值
  delete next.on_prompt
  if (ver !== "custom" && ver !== DEFAULT_VERSION) next.prompt = ver
  else delete next.prompt

  if (ver === "custom" && !$("op").value.trim()) {
    toast("自定义模式：把文本粘进下面的框，再保存")
    return
  }
  if (ver === "custom") next.on_prompt = $("op").value

  if (!bridgeOk) { toast("桥接不可用，仅记录在本页面", "warn"); return }
  try {
    const got = await withTimeout(magpie.options.set(next), 6000, "options.set 超时")
    loaded = got && typeof got === "object" ? got : next
    optionsToForm(loaded)
    toast("已切换：「" + labelOf(ver) + "」，下一个请求生效", "ok")
  } catch (e) {
    toast("写入失败（本地已记住选择）：" + e.message, "warn", 5000)
  }
}

const labelOf = (id) => id === "custom"
  ? "自定义"
  : (VERSIONS.find((v) => v.id === id)?.label ?? "—")

/* ---------- 状态展示 ---------- */
function sync() {
  const dirty = !sameOptions(formToOptions(), loaded)
  $("save").disabled = !dirty
  $("dirty").hidden = !dirty
  $("reset").disabled = !dirty
  const off = [...document.querySelectorAll('#agentList .switch[aria-checked="false"]')].length
  $("agentStat").textContent = (AGENTS.length - off) + "/" + AGENTS.length

  const ver = readVersion()
  const meta = VERSIONS.find((v) => v.id === ver)
  $("verStat").textContent = labelOf(ver)
  $("tokStat").textContent = ver === "custom"
    ? fmt($("op").value.length) + " 字"
    : (meta ? "~" + fmt(meta.tokens) + " tok" : "—")
  $("nStat").textContent = VERSIONS.length + ""
  const n = $("op").value.length
  $("opCount").textContent = n ? fmt(n) + " 字" : ""
}

function setBridge(state, text) {
  const el = $("bridge")
  el.className = "status " + state
  el.textContent = text
  el.title = state === "ok" ? "已连上 magpie 桥接，配置可读写"
    : state === "off" ? "没有 magpie 桥接：这张页面只是静态预览，改不了配置"
    : state === "err" ? "桥接存在但没响应：很可能插件选项 schema 没登记导致读写失败"
    : "正在握手"
  bridgeOk = state === "ok"
}

/* ---------- 保存 ---------- */
async function save() {
  const btn = $("save")
  btn.disabled = true
  btn.textContent = "保存中…"
  const next = formToOptions()
  try {
    const got = await withTimeout(magpie.options.set(next), 6000, "options.set 超时")
    loaded = got && typeof got === "object" ? got : next
    optionsToForm(loaded)
    btn.textContent = "已保存"
    btn.classList.add("saved")
    toast("已保存，下一个请求即生效", "ok")
    setTimeout(() => { btn.textContent = "保存配置"; btn.classList.remove("saved"); sync() }, 1200)
  } catch (e) {
    btn.textContent = "保存配置"
    toast("写入失败：" + (e.message || e), "warn", 6000)
  }
  sync()
}

/* ---------- 配色：跟着 magpie 走 ---------- */
// bridge 的 ready 返回 { dark, lang, tokens }。tokens 可能是对象（名字→值）
// 或字符串数组（"--bg: #fff"），两种都吃；认得的别名映射回本页变量，
// 认不得的原样挂到 :root 上，不报错。
const TOKEN_ALIAS = [
  ["accent", ["--color-accent", "--accent", "--brand", "--color-brand", "--primary", "--color-primary"]],
  ["accent-soft", ["--accent-soft", "--color-accent-soft", "--brand-soft"]],
  ["bg", ["--color-bg", "--bg", "--background", "--color-background", "--canvas"]],
  ["card", ["--color-surface", "--surface", "--card", "--color-card"]],
  ["fg", ["--color-text", "--text", "--fg", "--foreground", "--color-fg"]],
  ["muted", ["--color-text-secondary", "--text-secondary", "--muted", "--color-muted"]],
  ["line", ["--color-border", "--border", "--line", "--color-line"]],
  ["ok", ["--color-success", "--success", "--ok", "--green"]],
  ["warn", ["--color-warning", "--warning", "--warn", "--amber"]],
]

function applyTheme(theme) {
  if (!theme || typeof theme !== "object") return
  const root = document.documentElement
  if (typeof theme.dark === "boolean") root.dataset.theme = theme.dark ? "dark" : "light"

  const t = theme.tokens
  if (!t) return
  const pairs = []
  if (Array.isArray(t)) {
    for (const s of t) {
      if (typeof s !== "string") continue
      const i = s.indexOf(":")
      if (i > 0) pairs.push([s.slice(0, i).trim(), s.slice(i + 1).trim()])
    }
  } else if (typeof t === "object") {
    for (const k of Object.keys(t)) {
      const v = t[k]
      if (typeof v === "string" || typeof v === "number") pairs.push([k, String(v)])
    }
  }
  if (!pairs.length) return

  const norm = (k) => (k.startsWith("--") ? k : "--" + k.replace(/^_+/, "").replace(/_/g, "-"))
  const bag = new Map()
  for (const [rawK, v] of pairs) {
    const k = norm(rawK)
    root.style.setProperty(k, v)
    bag.set(k.toLowerCase(), v)
  }
  for (const [mine, cands] of TOKEN_ALIAS) {
    for (const c of cands) {
      const hit = bag.get(c.toLowerCase())
      if (hit) { root.style.setProperty("--" + mine, hit); break }
    }
  }
}

/* ---------- 启动 ---------- */
async function main() {
  $("ver").textContent = "v" + VERSION
  buildVersionList()
  buildAgentList([])

  for (const f of SCHEMA) {
    if (f.kind !== "bool") continue
    $(f.el).addEventListener("click", (e) => {
      const b = e.currentTarget
      b.setAttribute("aria-checked", isOn(b) ? "false" : "true")
      sync()
    })
  }
  $("posSeg").addEventListener("change", sync)
  for (const f of SCHEMA) {
    if (f.kind === "text" || f.kind === "list" || f.kind === "prompt") $(f.el).addEventListener("input", sync)
  }
  $("reset").addEventListener("click", () => { optionsToForm(loaded); toast("已还原为当前生效配置") })
  $("save").addEventListener("click", save)
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!$("save").disabled) save() }
  })
  const cp = async (id) => {
    try { await navigator.clipboard.writeText($(id).textContent); toast("命令已复制到剪贴板", "ok") }
    catch { toast("剪贴板被沙盒拒绝，请手动选择命令文本复制", "warn") }
  }
  $("copy1").addEventListener("click", () => cp("cmd1"))
  $("copy2").addEventListener("click", () => cp("cmd2"))

  // 先按本地镜像渲染，避免闪一下默认值
  optionsToForm({})
  const remembered = readLS()
  if (remembered) applySelection(remembered)

  if (!window.magpie || !window.magpie.options) {
    setBridge("off", "未连接 · 独立预览")
    return
  }
  setBridge("pending", "连接中…")

  try {
    const theme = await withTimeout(magpie.ready, 1500, "ready 超时")
    applyTheme(theme)
  } catch { /* 主题失败不影响功能 */ }

  try {
    const got = await withTimeout(magpie.options.get(), 4000, "options.get 超时")
    loaded = got && typeof got === "object" ? got : {}
    optionsToForm(loaded)
    const v = readVersion()
    writeLS(v)
    setBridge("ok", "已连接 · 可读写")
  } catch (e) {
    setBridge("err", "桥接无响应 · 只读")
    toast("读取配置失败：" + (e.message || e) + "；已回退到本地记录的选择", "warn", 5000)
  }
  sync()
}

main()
