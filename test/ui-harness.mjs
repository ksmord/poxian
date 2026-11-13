// test/ui-harness.mjs —— 真实组件 + 最小生命周期模拟
//
// 为什么这样读组件：poxian 的 page/ 是普通 script（window.PX_*），不是 ESM。
// 照 fujiang keyboard-harness.mjs 的做法，用 readFileSync + new Function 把
// **真实页面组件**装进最小假 window，而不是为测试另写一份替身——
// 测替身永远测不出「页面里那个函数」的回归。

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

// 假 window：预置构建期下发的两个全局（PX_EXPECT_PROTO / PX_SCHEMA_KEYS），
// 再装载真实组件源码。fujiang 的 createWindow() 同款思路，只是这里只模拟用得到的部分。
function fakeWindow() {
  return {
    PX_EXPECT_PROTO: 3,
    PX_SCHEMA_KEYS: ["enabled", "override", "position", "prompt", "on_prompt", "prompt_path"],
  }
}
function loadComponent(rel, key) {
  const root = fakeWindow()
  const code = readFileSync(new URL(rel, import.meta.url), "utf8")
  new Function("globalThis", code)(root)          // 组件读/写 root.PX_*
  return root[key]
}
const KEYS = loadComponent("../page/keys.js", "PX_KEYS")
const HEALTH = loadComponent("../page/health.js", "PX_HEALTH")
const { shouldSave, installSaveHotkey, mountGate } = KEYS
const { applyHealth, mergeForWrite, detectUnknownOptionKeys } = HEALTH

// 最小 DOM：只实现组件真正用到的接口，不引第三方
function fakeDoc() {
  const handlers = new Set()
  return {
    handlers,
    addEventListener(type, fn, capture) { assert.equal(type, "keydown"); assert.equal(capture, true); handlers.add(fn) },
    removeEventListener(type, fn, capture) { assert.equal(type, "keydown"); assert.equal(capture, true); handlers.delete(fn) },
    fire(e) { for (const fn of [...handlers]) fn({ preventDefault() { e.prevented = true }, ...e }) },
  }
}
function key(o = {}) { return { key: "s", ctrlKey: true, isComposing: false, keyCode: 83, ...o } }
function fakeEls() {
  return {
    health: { textContent: "", dataset: {} },
    unknown: { textContent: "" },
    save: { disabled: false, title: "", dataset: { dirty: "1" }, removeAttribute() { this.title = "" } },
  }
}

import { arm, attempt, injected as noteInjected, failed as noteFailed, status, reset } from "../src/status.mjs"

test("Ctrl/Cmd+S 触发保存，普通 s 与 Shift+S 不触发", () => {
  assert.equal(shouldSave(key()), true)
  assert.equal(shouldSave(key({ ctrlKey: false, metaKey: true })), true)
  assert.equal(shouldSave(key({ ctrlKey: false })), false)
  assert.equal(shouldSave(key({ shiftKey: true })), false)
})

test("中文输入法组合中（isComposing / keyCode 229）不误触发保存", () => {
  assert.equal(shouldSave(key({ isComposing: true })), false)
  assert.equal(shouldSave(key({ keyCode: 229 })), false)
  assert.equal(shouldSave(key({ key: "Process", keyCode: 229 })), false)
})

test("安装 → 触发 → 卸载后事件不再到达（隐藏期间零监听）", () => {
  const doc = fakeDoc(); let hits = 0
  const un = installSaveHotkey(doc, () => hits++, () => true)
  assert.equal(doc.handlers.size, 1)
  doc.fire(key()); assert.equal(hits, 1)
  un()
  assert.equal(doc.handlers.size, 0)
  doc.fire(key()); assert.equal(hits, 1)
})

test("脏检测为 false 时按键被吞", () => {
  const doc = fakeDoc(); let hits = 0
  installSaveHotkey(doc, () => hits++, () => false)
  doc.fire(key()); assert.equal(hits, 0)
})

test("确认弹层：Enter 同意 / Esc 隐藏 / 已同意不重复装", () => {
  const doc = fakeDoc(); const gate = { hidden: false }; const calls = []
  const un = mountGate(doc, gate, { accepted: false, onAccept: (w) => calls.push(w) })
  doc.fire({ key: "Enter", isComposing: false, keyCode: 13 }); assert.deepEqual(calls, ["enter"])
  doc.fire({ key: "Escape", isComposing: false, keyCode: 27 }); assert.equal(gate.hidden, true)
  un()
  const doc2 = fakeDoc()
  assert.equal(doc2.handlers.size, 0)
  mountGate(doc2, gate, { accepted: true, onAccept: () => {} })
  assert.equal(doc2.handlers.size, 0)
})

// 协议错配 + 错误原文透传：fujiang 的 setStale / lastError 语义
test("proto 一致：显示已注入次数，保存可用", () => {
  const els = fakeEls()
  applyHealth({ proto: 3, injected: 3, skipped: 7, lastError: null, unknownKeys: [] }, els, 3)
  assert.match(els.health.textContent, /已注入 3 次/)
  assert.equal(els.save.disabled, false)
})

test("proto 错配：禁用保存并给出可执行提示", () => {
  const els = fakeEls()
  applyHealth({ proto: 2, injected: 0, skipped: 0, lastError: null }, els, 3)
  assert.equal(els.save.disabled, true)
  assert.match(els.health.textContent, /完全退出/)
})

test("注入失败：内核错误原文直达概要条", () => {
  const els = fakeEls()
  applyHealth({ proto: 3, injected: 0, skipped: 0, lastError: "ENOENT: prompts/v4.md" }, els, 3)
  assert.match(els.health.textContent, /ENOENT: prompts\/v4\.md/)
})

test("陌生配置键：计数显示且已保留", () => {
  const els = fakeEls()
  applyHealth({ proto: 3, injected: 1, skipped: 0, unknownKeys: ["prefix_v2"] }, els, 3)
  assert.match(els.unknown.textContent, /prefix_v2/)
})

// ---- 运行态层：armed / injected / lastError 与内核原文 ----


test("status：armed / attempted / injected / skipped 四态自洽", () => {
  reset(); arm({ enabled: true })
  attempt(); noteInjected({ action: "inject", src: "prompts/富江人格破甲.md" })
  attempt()   // 第二次进了链路但没写出去
  const s = status()
  assert.equal(s.armed, true)
  assert.equal(s.attempted, 2)
  assert.equal(s.injected, 1)
  assert.equal(s.skipped, 1)
})

test("status：错误原文保留到下一次成功才清空", () => {
  reset(); arm({ enabled: true })
  attempt(); noteFailed(new Error("ENOENT: prompts/v4.md"))
  assert.match(status().lastError, /ENOENT: prompts\/v4\.md/)
  assert.ok(status().lastErrorAt > 0)
  noteInjected({ action: "inject" })
  assert.equal(status().lastError, null)
})

test("status：proto 来自 constants，页面按同一号判定", () => {
  reset()
  assert.equal(status().proto, 3)
})

// ---- 非破坏性写：另一版本写的键不能被抹掉 ----

test("mergeForWrite：只覆盖认识的键，陌生键原样保留", () => {
  const base = { enabled: true, prompt: "fujiang", prefix_v2: "来自另一版本" }
  const next = mergeForWrite(base, { prompt: "dagou", evil_key: 1 })
  assert.equal(next.prompt, "dagou")
  assert.equal(next.prefix_v2, "来自另一版本")
  assert.equal(next.evil_key, undefined)
  assert.deepEqual(detectUnknownOptionKeys(base), ["prefix_v2"])
})

test("宿主未提供 status RPC：明说通道未接通，不误禁用保存", () => {
  const els = fakeEls()
  applyHealth(null, els, 3)
  assert.match(els.health.textContent, /通道未接通/)
  assert.equal(els.save.disabled, false)
  assert.equal(HEALTH.staleFlag, false)
})
