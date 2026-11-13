// page/health.js —— 普通 script（与 versions.js / agents.js / app.js 一致，无 import/export）
// 由 index.html 以 <script src="health.js?v=..."> 引入，挂在 window.PX_HEALTH。
//
// 为什么：poxian 的 page/ 跑在沙箱 iframe，全是普通 script；ESM 版贴进来会直接语法错。
// 协议号与 schema 键由 scripts/build-prompts.mjs 写进 versions.js（唯一真相源）。
//
// 为什么协议号：fujiang 的 API_PROTO / EXPECT_PROTO 配对是 2→3 事故换来的——
// 新界面 + 旧宿主（只刷新页面没重启进程）时旧宿主 normalize 静默丢掉新字段。
// poxian 的 page 刷新即拿新 bundle，Bun plugin host 不重启就是旧代码，0.2.1 已吃过一次。

;(function (root) {
  "use strict"

  var EXPECT = Number(root.PX_EXPECT_PROTO || 0)
  var KNOWN = new Set(root.PX_SCHEMA_KEYS || [])

  function detectUnknownOptionKeys(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
    return Object.keys(raw).filter(function (k) { return !KNOWN.has(k) })
  }

  // 非破坏性合并：只覆盖本版本认识的键，保留另一版本写进来的键（fujiang writeFileConfig 同款）
  function mergeForWrite(base, patch) {
    var out = Object.assign({}, base && typeof base === "object" && !Array.isArray(base) ? base : {})
    Object.keys(patch || {}).forEach(function (k) { if (KNOWN.has(k)) out[k] = patch[k] })
    return out
  }

  function applyHealth(s, els, expectProto) {
    var want = expectProto === undefined ? EXPECT : expectProto
    var noChannel = s == null                       // 宿主没提供 status RPC
    var stale = !noChannel && s.proto !== want       // 真·协议错配
    var err = s && s.lastError

    els.health.textContent = noChannel
      ? "运行态通道未接通：配置读写不受影响，详细错误见 poxian.jsonl"
      : stale
        ? "宿主未重启：请完全退出 magpie（含托盘）后重开"
        : "已注入 " + s.injected + " 次 · 跳过 " + s.skipped + " 次 · 错误 " + (err ? 1 : 0) +
          (err ? " · 最近错误：" + err : "")
    els.health.dataset.level = noChannel ? "muted" : (stale || err ? "warn" : "ok")

    // 只置 flag 与 title，绝不覆盖 sync() 脏检测算出来的 disabled：
    // 真错配时由 app.js 的 save() 开头拦一次，保证 sync() 之后仍然拦得住。
    root.PX_HEALTH.staleFlag = stale
    if (stale) {
      els.save.disabled = true
      els.save.title = "宿主进程未重启，写入会被旧代码丢弃"
    } else if (els.save.title === "宿主进程未重启，写入会被旧代码丢弃") {
      els.save.removeAttribute("title")
    }

    var unknown = (s && s.unknownKeys) || detectUnknownOptionKeys(s && s.config)
    els.unknown.textContent = unknown.length
      ? "配置里有 " + unknown.length + " 个本版本未识别的键，已原样保留：" + unknown.join(", ")
      : ""
  }

  // 非破坏性保存：options.get 回读作底 → 只覆盖认识的键 → options.set 整份写回
  async function saveOptions(bridge, patch, formToOptions, toast) {
    var base = await bridge.get()
    var next = mergeForWrite(base, formToOptions(patch))
    var unknown = detectUnknownOptionKeys(base)
    if (unknown.length) toast("已保留 " + unknown.length + " 个未识别的键", "warn")
    await bridge.set(next)
    return next
  }

  root.PX_HEALTH = {
    EXPECT_PROTO: EXPECT,
    staleFlag: false,
    applyHealth: applyHealth,
    saveOptions: saveOptions,
    mergeForWrite: mergeForWrite,
    detectUnknownOptionKeys: detectUnknownOptionKeys,
  }
})(typeof globalThis !== "undefined" ? globalThis : window)
