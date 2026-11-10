// poxian 控制台 —— 零依赖。桥接 API（_magpie/bridge.js）：
//   await magpie.ready            { dark, lang, tokens }
//   await magpie.options.get()    本插件当前配置
//   await magpie.options.set(o)   写回并持久化，返回写后的值
//
// 版本元数据来自 versions.js（构建产物，window.PX_VERSIONS）。
//
// 表单字段由 SCHEMA 声明：加一个选项只改 SCHEMA 一行 + index.html 一行，
// 读表单 / 写表单 / 脏检测三处自动跟随，不再各自维护字段清单。

const VERSION = "1.4.0"

const AGENTS = window.HG_AGENTS || []
const VERSIONS = window.PX_VERSIONS || []
const DEFAULT_VERSION = window.PX_DEFAULT_VERSION || "v52"

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
  { key: "on_prompt", kind: "prompt", def: "" },
]

/* ---------- toast ---------- */
function toast(text, kind = "", ms = 2800) {
  const t = $("toast")
  t.textContent = text
  t.className = "toast show " + kind
  clearTimeout(toast._h)
  toast._h = setTimeout(() => (t.className = "toast"), ms)
}

/* ---------- 动态构建：版本列表 + Agent 行 ---------- */
function buildVersionList() {
  const box = $("verList")
  for (const v of VERSIONS) {
    const row = document.createElement("div")
    row.className = "prow"
    row.dataset.ver = v.id
    row.innerHTML =
      '<div class="p-main"><div class="p-name">' + v.label +
      (v.badge ? ' <span class="p-badge">' + v.badge + '</span>' : "") +
      '</div><div class="p-desc">' + v.desc + ' · ' + Math.round(v.chars / 1000) + 'K 字</div></div>' +
      '<span class="p-check">✓</span>'
    row.addEventListener("click", () => {
      $("opRow").hidden = true
      for (const r of box.querySelectorAll(".prow")) r.classList.toggle("on", r === row)
      sync()
    })
    box.appendChild(row)
  }
  const custom = document.createElement("div")
  custom.className = "prow"
  custom.dataset.ver = "custom"
  custom.innerHTML = '<div class="p-main"><div class="p-name">自定义文本 <span class="p-badge">on_prompt</span></div>' +
    '<div class="p-desc">整段粘贴你自己的系统提示词，优先级最高</div></div><span class="p-check">✓</span>'
  custom.addEventListener("click", () => {
    $("opRow").hidden = false
    for (const r of box.querySelectorAll(".prow")) r.classList.toggle("on", r === custom)
    sync()
  })
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

// 只写非默认值：默认项不落库，脏检测也不会因缺省键误报
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
      document.querySelector('input[name="' + f.name + '"][value="' + v + '"]').checked = true
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
  for (const r of document.querySelectorAll(".prow")) r.classList.toggle("on", r.dataset.ver === ver)
  $("opRow").hidden = ver !== "custom"
  $("op").value = hasCustom || ""
  sync()
}

/* ---------- 脏状态：逐字段比较，不看键序 ---------- */
function norm(list) {
  return Array.isArray(list) ? list.map(String).sort().join("\u0000") : ""
}

// 归一化成同一形状再比：缺省键、显式默认值、键序不同都不算脏
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
    if (A[keys[i]] !== B[keys[i]]) return false
  }
  return true
}

let loaded = {}

function sync() {
  const dirty = !sameOptions(formToOptions(), loaded)
  $("save").disabled = !dirty
  $("dirty").hidden = !dirty
  $("reset").disabled = !dirty
  const off = [...document.querySelectorAll('#agentList .switch[aria-checked="false"]')].length
  $("agentStat").textContent = (AGENTS.length - off) + " / " + AGENTS.length
  const ver = readVersion()
  $("verStat").textContent = ver === "custom"
    ? "自定义"
    : (VERSIONS.find((v) => v.id === ver)?.label ?? "—")
  const n = $("op").value.length
  $("opCount").textContent = n ? n.toLocaleString() + " 字" : ""
}

/* ---------- 保存 ---------- */
async function save() {
  const btn = $("save")
  btn.disabled = true
  btn.textContent = "保存中…"
  const next = formToOptions()
  try {
    const got = await magpie.options.set(next)
    loaded = got && typeof got === "object" ? got : next
    btn.textContent = "✓ 已保存"
    btn.classList.add("saved")
    toast("已保存，下一个请求即生效", "ok")
    setTimeout(() => { btn.textContent = "保存配置"; btn.classList.remove("saved"); sync() }, 1400)
  } catch (e) {
    toast("此版本桥接不支持写入 —— 命令行等效：magpie plugin options poxian " + JSON.stringify(next), "warn", 6500)
    btn.textContent = "保存配置"
  }
  sync()
}

/* ---------- 启动 ---------- */
async function main() {
  $("ver").textContent = "v" + VERSION
  buildVersionList()
  buildAgentList([])

  // 所有 bool 开关统一绑定
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

  optionsToForm({})
  if (!window.magpie) {
    $("bridgeText").textContent = "独立预览 · 桥接不可用"
    return
  }
  try { await magpie.ready } catch { /* 主题失败不影响功能 */ }
  try {
    loaded = (await magpie.options.get()) || {}
    optionsToForm(loaded)
    $("bridge").classList.remove("off")
    $("bridgeText").textContent = "桥接已连接 · 配置可读写"
  } catch (e) {
    $("bridgeText").textContent = "配置读取失败"
    toast("options.get 失败：" + e, "warn", 5000)
  }
}

main()
