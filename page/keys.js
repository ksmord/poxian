// page/keys.js —— 普通 script，挂 window.PX_KEYS
// 真实键盘组件（页面与测试共用同一份）：测试用 readFileSync + new Function 提取它，
// 正是 fujiang keyboard-harness.mjs 的「提取真实组件 + 最小生命周期模拟」做法。
//
// fujiang 0.20.13 修的两条：忽略 isComposing / keyCode 229（中文候选词确认），
// 弹层隐藏后不再注册键盘监听（见卸载函数）。poxian page/app.js:517 目前两条都缺。

;(function (root) {
  "use strict"

  function shouldSave(e) {
    if (!e) return false
    if (e.isComposing || e.keyCode === 229) return false   // 输入法正在组合文字
    if (!(e.ctrlKey || e.metaKey)) return false
    if (String(e.key || "").toLowerCase() !== "s") return false
    if (e.altKey || e.shiftKey) return false
    return true
  }

  function installSaveHotkey(doc, onSave, isDirty) {
    if (!doc || typeof doc.addEventListener !== "function") return function () {}
    function handler(e) {
      if (!shouldSave(e)) return
      e.preventDefault()
      if (typeof isDirty === "function" && !isDirty()) return
      onSave()
    }
    doc.addEventListener("keydown", handler, true)
    return function () { doc.removeEventListener("keydown", handler, true) }
  }

  function mountGate(doc, gate, opts) {
    if (opts.accepted || !gate) return function () {}
    function handler(e) {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); opts.onAccept("enter") }
      else if (e.key === "Escape") { e.preventDefault(); gate.hidden = true }
    }
    doc.addEventListener("keydown", handler, true)
    return function () { doc.removeEventListener("keydown", handler, true) }
  }

  root.PX_KEYS = {
    shouldSave: shouldSave,
    installSaveHotkey: installSaveHotkey,
    mountGate: mountGate,
  }
})(typeof globalThis !== "undefined" ? globalThis : window)
