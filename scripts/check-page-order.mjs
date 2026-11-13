// page/ 脚本装载顺序与组件挂载验证
// 为什么：ui-harness.mjs 测的是组件本身，测不到 index.html 里 <script src> 的**真实顺序**。
// 组件若在 app.js 之后才挂载，页面运行时 PX_HEALTH / PX_KEYS 就是 undefined，静态守卫查不出来。
// 这里按 HTML 里的真实顺序，用最小假 window 装载前几个脚本并校验全局。

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const page = join(dirname(fileURLToPath(import.meta.url)), "..", "page")
const html = readFileSync(join(page, "index.html"), "utf8")
const srcs = [...html.matchAll(/<script src="([^"]+)"/g)]
  .map((m) => m[1].split("?")[0])
  .filter((s) => !s.startsWith("_magpie") && !s.startsWith("http"))

const need = ["versions.js", "health.js", "keys.js", "app.js"]
for (const n of need) {
  if (!srcs.includes(n)) throw new Error("index.html 缺脚本: " + n)
}
if (srcs.indexOf("versions.js") >= srcs.indexOf("health.js") ||
    srcs.indexOf("health.js") >= srcs.indexOf("app.js") ||
    srcs.indexOf("keys.js") >= srcs.indexOf("app.js")) {
  throw new Error("组件脚本必须排在 app.js 之前，实际: " + srcs.join(" → "))
}

const win = {}
for (const f of srcs) {
  if (f === "app.js" || f === "agents.js") continue   // 依赖完整 DOM，交由 ui-harness 测
  const p = join(page, f)
  new Function("window", "globalThis", readFileSync(p, "utf8"))(win, win)
}

const H = win.PX_HEALTH
const K = win.PX_KEYS
if (!H || !K) throw new Error("PX_HEALTH / PX_KEYS 未挂载")
if (Number(win.PX_EXPECT_PROTO) !== 3) throw new Error("PX_EXPECT_PROTO 应为 3，实际 " + win.PX_EXPECT_PROTO)
if (!Array.isArray(win.PX_SCHEMA_KEYS) || win.PX_SCHEMA_KEYS.length < 20) {
  throw new Error("PX_SCHEMA_KEYS 缺失或过少")
}

const els = {
  health: { textContent: "", dataset: {} },
  unknown: { textContent: "" },
  save: { disabled: false, title: "", dataset: { dirty: "1" }, removeAttribute() { this.title = "" } },
}
H.applyHealth(null, els)                   // 宿主未提供 status RPC 的三态
if (els.save.disabled !== false) throw new Error("无 RPC 时误禁用保存")
if (H.staleFlag !== false) throw new Error("无 RPC 时误判协议错配")
if (!els.health.textContent.includes("通道未接通")) throw new Error("无 RPC 时未明说通道未接通")

if (K.shouldSave({ key: "s", ctrlKey: true, isComposing: true, keyCode: 229 }) !== false) {
  throw new Error("IME 合成事件未拦截")
}
if (K.shouldSave({ key: "s", ctrlKey: true, isComposing: false, keyCode: 83 }) !== true) {
  throw new Error("Ctrl+S 未放行")
}

console.log("  ✓ 脚本顺序: " + srcs.join(" → "))
console.log("  ✓ PX_EXPECT_PROTO=3 / PX_SCHEMA_KEYS=" + win.PX_SCHEMA_KEYS.length + " 项")
console.log("  ✓ 无 RPC 三态 / IME 拦截 / Ctrl+S 放行 全部正确")
