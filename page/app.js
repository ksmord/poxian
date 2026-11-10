// poxian 控制台 —— 零依赖。桥接 API（_magpie/bridge.js）：
//   await magpie.ready            { dark, lang, tokens }
//   await magpie.options.get()    本插件当前配置
//   await magpie.options.set(o)   写回并持久化，返回写后的值
//
// 版本元数据来自 versions.js（构建产物，window.PX_VERSIONS）。
//
// 表单字段由 SCHEMA 声明：加一个选项只改 SCHEMA 一行 + index.html 一行，
// 读表单 / 写表单 / 脏检测三处自动跟随，不再各自维护字段清单。

const VERSION = "0.0.6"

const AGENTS = window.HG_AGENTS || []
const VERSIONS = window.PX_VERSIONS || []
const DEFAULT_VERSION = window.PX_DEFAULT_VERSION || "v5"

// 选中态本地镜像：桥接读不到 / 超时也不会丢选择
const LS_KEY = "poxian.prompt"
// 配置镜像：magpie 的 options.get 在这版桥接上不稳定（实测返回 undefined），
// 读不到时用最近一次写入成功的整份配置回填界面，避免"保存后看着像丢了"。
const LS_OPTS = "poxian.options"

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
  { key: "cache",     kind: "bool", el: "ce", def: false },
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
function readLSopts() {
  try {
    const raw = localStorage.getItem(LS_OPTS)
    const o = raw ? JSON.parse(raw) : null
    return o && typeof o === "object" ? o : null
  } catch { return null }
}
function writeLSopts(o) {
  try { localStorage.setItem(LS_OPTS, JSON.stringify(o)) } catch {}
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
    const v = x[f.key] === undefined ? f.def : x[f.key]
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

// 注意：magpie 的 options.set 是【整份替换】，不是合并。
// 所以这里必须产出完整对象——每个键都写明确值，不能只回传被改动的键，
// 否则未改动的 prompt / models / agents_off 会被清空（表现为"保存后配置丢了"）。
function formToOptions() {
  const next = {}
  next.agents_off = [...document.querySelectorAll('#agentList .switch[aria-checked="false"]')]
    .map((b) => b.getAttribute("aria-label"))

  for (const f of SCHEMA) {
    if (f.kind === "bool") {
      next[f.key] = isOn($(f.el))
    } else if (f.kind === "seg") {
      next[f.key] = document.querySelector('input[name="' + f.name + '"]:checked').value
    } else if (f.kind === "text") {
      next[f.key] = $(f.el).value.trim()
    } else if (f.kind === "list") {
      next[f.key] = $(f.el).value.split(",").map((s) => s.trim()).filter(Boolean)
    } else if (f.kind === "ver") {
      const v = readVersion()
      next.prompt = v === "custom" ? DEFAULT_VERSION : v
    } else if (f.kind === "prompt") {
      next[f.key] = readVersion() === "custom" ? $(f.el).value : ""
    }
  }
  return next
}

function optionsToForm(o) {
  const src = o || {}
  const pick = (f) => (src[f.key] === undefined ? f.def : src[f.key])
  for (const f of SCHEMA) {
    if (f.kind === "bool") {
      $(f.el).setAttribute("aria-checked", pick(f) !== false ? "true" : "false")
    } else if (f.kind === "seg") {
      const v = pick(f) === "append" ? "append" : "prepend"
      const input = document.querySelector('input[name="' + f.name + '"][value="' + v + '"]')
      if (input) input.checked = true
    } else if (f.kind === "text") {
      const v = pick(f)
      $(f.el).value = typeof v === "string" ? v : ""
    } else if (f.kind === "list") {
      const v = pick(f)
      $(f.el).value = Array.isArray(v) ? v.join(", ") : ""
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
/* ---------- 写入队列 ----------
   magpie 对 options.set 限流：每页每秒最多 1 次；且沙箱 iframe（不透明源）里
   父页面的回执可能永远收不到——但父页面是【先落盘、后发回执】，所以回执丢了
   不等于写入失败。策略：
   - 乐观提交：界面立即按写入后的状态走（脏标记立刻清零，绝不卡 6 秒）
   - 后台串行队列：≥1.1s 间隔落盘，期间多次改动自动合并为最新一份
   - 撞限流自动退避重试 */
let bridgeOk = false
const IS_FRAME = (() => { try { return window.parent !== window } catch { return true } })()

let qState = null, qTimer = null, qBusy = false, qLast = 0

function queueWrite(next) {
  qState = next
  if (qBusy) return
  const wait = Math.max(0, 1100 - (Date.now() - qLast))
  clearTimeout(qTimer)
  qTimer = setTimeout(flushWrite, wait)
}

async function flushWrite() {
  if (qBusy || qState == null) return
  qBusy = true
  const next = qState
  qState = null
  qLast = Date.now()
  let err = null
  try {
    const got = await withTimeout(magpie.options.set(next), 4000, "set 无回执")
    if (got && typeof got === "object") loaded = got
  } catch (e) { err = e }
  qBusy = false
  if (err && /once a second|一秒/.test(String(err && err.message || err))) {
    qState = next            // 撞限流：退避后重试同一份
  } else if (err) {
    // 回执丢失 ≠ 写入失败，界面保持乐观状态，不打扰用户
    console.warn("poxian: set 无回执（大概率已生效）:", (err && err.message) || err)
  }
  // 用户在后台写入期间又动了表单：保留界面等下一次保存；否则按最终状态归一
  const dirtyNow = !sameOptions(formToOptions(), loaded)
  if (!dirtyNow) {
    writeLSopts(loaded)
    optionsToForm(loaded)
  }
  sync()
  if (qState != null) queueWrite(qState)
}

async function selectVersion(ver) {
  if (ver === "custom" && !$("op").value.trim()) {
    applySelection(ver)
    writeLS(ver)
    toast("自定义模式：把文本粘进下面的框，再保存")
    return
  }
  applySelection(ver)
  writeLS(ver)

  // options.set 是整份替换：以「当前生效值」为底，只改提示词两个键，绝不发稀疏对象
  const next = normOptions(loaded)
  if (ver === "custom") {
    next.on_prompt = $("op").value
  } else {
    next.on_prompt = ""
    next.prompt = ver
  }

  if (!bridgeOk) { toast("桥接不可用，仅记录在本页面", "warn"); return }
  loaded = next
  writeLSopts(loaded)
  toast("已切换：「" + labelOf(ver) + "」，下一个请求生效", "ok")
  queueWrite(next)
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
function save() {
  const btn = $("save")
  if (!bridgeOk) { toast("桥接不可用，仅记录在本页面", "warn"); return }
  const next = formToOptions()
  loaded = next
  writeLSopts(loaded)
  btn.classList.add("saved")
  btn.textContent = "已保存"
  toast("已保存，下一个请求即生效", "ok")
  setTimeout(() => { btn.textContent = "保存配置"; btn.classList.remove("saved"); sync() }, 1200)
  queueWrite(next)
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

  if (!IS_FRAME) {
    // 顶层直开：bridge 的 parent 是页面自己，调用会"自问自答"瞬间返回 undefined，
    // 写入根本到不了 magpie。诚实显示，只当本地预览用。
    setBridge("off", "独立预览 · 请从 magpie 侧边栏打开")
    loaded = readLSopts() || {}
    optionsToForm(loaded)
    writeLS(readVersion())
    sync()
    return
  }

  let got = null
  try {
    got = await withTimeout(magpie.options.get(), 3000, "options.get 超时")
  } catch { got = null }

  const remote = got && typeof got === "object" && Object.keys(got).length ? got : null
  const mirror = readLSopts()
  loaded = remote || mirror || {}
  optionsToForm(loaded)

  if (remote) {
    writeLSopts(remote)
    setBridge("ok", "已连接 · 可读写")
  } else if (mirror) {
    setBridge("ok", "已连接 · 本地镜像")
    toast("没读到已存配置，界面按本地镜像显示；改动会整份写入生效", "warn", 6000)
  } else {
    setBridge("ok", "已连接 · 无回执模式")
    toast("没读到已存配置（无回执模式）：界面按默认值显示；改动会整份写入生效", "warn", 6000)
  }
  writeLS(readVersion())
  sync()
}

main()
