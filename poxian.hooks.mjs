// poxian · 异步网关钩子入口
//
// magpie.hooks 契约：export async function onRequest(body, ctx)
//   - 返回 body  → 替换请求
//   - 返回 undefined → 请求原样放行（失败/超时/未知协议一律走这条）
//
// 与同步中间件壳的区别：这里跑在 Bun plugin host，有 node:fs，
// 所以 payload 可以是外部 .md 文件，每请求 stat，改完即生效。

import { normalize } from "./src/options.mjs"
import { resolvePrompt, handshakeText } from "./src/payload.mjs"
import { handle } from "./src/core.mjs"
import { record } from "./src/observe.mjs"

export async function onRequest(body, ctx) {
  const t0 = Date.now()
  const c = ctx || {}
  const o = normalize(c.options)

  if (!o.enabled) return undefined

  try {
    const payload = await withTimeout(resolvePrompt(o, c), o.gatewayTimeoutMs)
    payload.handshake = handshakeText()

    const r = handle(body, c, payload, o)
    record(o, c, {
      action: r.action,
      src: payload.source,
      bytes: payload.text.length,
      ms: Date.now() - t0,
      ...r.meta,
    })
    return r.body
  } catch (e) {
    // 超时、权限、格式——任何异常都放行原请求，绝不挂住
    record(o, c, {
      action: "error",
      error: String((e && e.message) || e),
      ms: Date.now() - t0,
    })
    return undefined
  }
}

function withTimeout(p, ms) {
  if (!ms || ms <= 0) return p
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("poxian: payload timeout " + ms + "ms")), ms)
    if (t && typeof t.unref === "function") t.unref()
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}
