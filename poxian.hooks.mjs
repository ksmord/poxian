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
import { precheck, handle } from "./src/core.mjs"
import { record } from "./src/observe.mjs"
import { judge } from "./src/probe.mjs"
import { createHash } from "node:crypto"

export async function onRequest(body, ctx) {
  const t0 = Date.now()
  const c = ctx || {}
  const o = normalize(c.options)

  if (!o.enabled) return undefined

  // 前置判定先跑：skip-* 类请求连 stat 都不做，直接放行。
  // 旧版是“先解析载荷再过滤”，被 agents_off 挡掉的流量也要白付一次 IO。
  const pre = precheck(body, c, o)
  if (pre) {
    record(o, c, {
      action: pre.action,
      src: null,
      bytes: 0,
      ms: Date.now() - t0,
      ...(pre.meta || {}),
    })
    return undefined
  }

  try {
    const payload = await withTimeout(resolvePrompt(o, c), o.gatewayTimeoutMs)
    payload.handshake = handshakeText()

    const r = handle(body, c, payload, o)
    const { written, ...meta } = r.meta || {}
    record(o, c, {
      action: r.action,
      src: payload.source,
      bytes: Buffer.byteLength(written || payload.text, "utf8"),
      payload_bytes: payload.bytes,
      payload_sha256: sha256(payload.text),
      ...(payload.oversize ? { oversize: true, requested_bytes: payload.requested_bytes } : {}),
      ...(payload.path_blocked ? { path_blocked: true } : {}),
      ms: Date.now() - t0,
      ...meta,
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

// 响应侧探针。magpie 会丢弃本函数的返回值（plugin-host host.js:1707），
// 所以这里只能观测，不能改写回复——这是契约，不是实现缺陷。
// 返回值留空，避免后来者误以为能改。
export async function onResponse(reply, ctx) {
  const c = ctx || {}
  const o = normalize(c.options)

  if (!o.enabled) return
  if (!o.probe_echo && !o.probe_refusal) return

  const nonce = c.state && typeof c.state === "object" ? c.state.probeNonce : null
  if (o.probe_echo && !nonce) return // 上一轮没注入或没生成标记，无从判定

  try {
    const verdict = judge({
      reply,
      nonce,
      wantEcho: o.probe_echo,
      wantRefusal: o.probe_refusal,
    })
    record(o, c, {
      action: "probe",
      src: null,
      bytes: 0,
      ms: 0,
      success: c.success === true,
      ...(nonce ? { probe_nonce: nonce } : {}),
      ...verdict,
    })
  } catch (e) {
    record(o, c, { action: "probe-error", error: String((e && e.message) || e), ms: 0 })
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

// 载荷指纹：只进日志，不进报文，不消耗 token。
// 用途：事后对账——上游把 system 截断或抹掉标记时，靠这个对照同一份载荷的注入次数。
function sha256(text) {
  try {
    return createHash("sha256").update(String(text), "utf8").digest("hex")
  } catch {
    return null
  }
}
