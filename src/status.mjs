// poxian · 运行态
// 纯内存，不 import node:fs —— 同步中间件壳与异步钩子入口共用。
//
// 为什么单独一层：observe.mjs 的契约是「观察失败一律吞掉，不许影响请求」，
// 这条契约要保留；但「吞掉」不等于「看不见」。fujiang 0.3.0 的全部重构
// 就是把被 try/catch 吞进 logger 的异常，变成 /config 回传的
// armed / injected / lastError，让设置页显示真实状态而不是无条件「已保存」。

import { API_PROTO } from "./constants.mjs"

const state = {
  armed: false,        // 配置就绪（normalize 后 enabled 生效）
  attempted: 0,        // 进入注入链路的请求数（precheck 放行不计）
  injected: 0,         // 真正写出 system 的请求数
  lastError: null,     // 最近一次失败的内核/文件错误原文
  lastErrorAt: 0,
  lastAction: null,
  lastSrc: null,
  lastSha256: null,
}

export function arm(o) {
  state.armed = !!(o && o.enabled)
}

export function attempt() {
  state.attempted++
}

export function injected(meta = {}) {
  state.injected++
  state.lastError = null
  state.lastErrorAt = 0
  state.lastAction = meta.action || "inject"
  state.lastSrc = meta.src || null
  state.lastSha256 = meta.sha256 || null
}

export function failed(err, meta = {}) {
  state.lastError = String((err && err.message) || err)
  state.lastErrorAt = Date.now()
  state.lastAction = meta.action || "error"
}

export function status() {
  return {
    proto: API_PROTO,
    ...state,
    // 让页面区分「请求本来就被过滤跳过」和「注入链路挂了」
    skipped: state.attempted - state.injected,
  }
}

// 测试里要确定性；生产不调用。
export function reset() {
  Object.assign(state, {
    armed: false, attempted: 0, injected: 0,
    lastError: null, lastErrorAt: 0,
    lastAction: null, lastSrc: null, lastSha256: null,
  })
}
