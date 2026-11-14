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
import { notePrefillResult } from "./src/prefill.mjs"
import { decideTier, sessionKey } from "./src/policy.mjs"
import * as latch from "./src/latch.mjs"
import { createHash } from "node:crypto"
import { arm, attempt, injected as noteInjected, failed as noteFailed, status } from "./src/status.mjs"

// 宿主把 status() 暴露给设置页；没有 RPC 时页面显示「通道未接通」而不是假绿。
export { status }

export async function onRequest(body, ctx) {
  const t0 = Date.now()
  const c = ctx || {}
  let o = normalize(c.options)
  arm(o)

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

  attempt()                                 // 新增：进入注入链路

  // ============ 注入档位 ============
  // always 是默认：每轮全量，与 0.2.7 完全一致。
  // tiered / on_refusal 才走锁存与骨架。任何判定异常都回全量——省钱不能省出人格消失。
  let tier = "full"
  let key = null
  if (o.inject_mode !== "always") {
    try {
      key = sessionKey(body, c)
      tier = decideTier(body, o, key, t0)
    } catch (e) {
      tier = "full"
      record(o, c, { action: "tier-error", src: null, bytes: 0, ms: Date.now() - t0, error: String((e && e.message) || e) })
    }
    if (tier === "none") {
      record(o, c, { action: "skip-tier", src: null, bytes: 0, ms: Date.now() - t0, tier, session: key })
      return undefined
    }
    if (tier === "skeleton") {
      // 骨架必须是实测过的载荷，默认 fujiang-lite（897 tok）；
      // skeleton_prompt / skeleton_path 都空时 decideTier 已经回退 full，这里不会走到。
      o = o.skeleton_path
        ? { ...o, prompt: "", prompt_path: o.skeleton_path, on_prompt: "" }
        : { ...o, prompt: o.skeleton_prompt, prompt_path: "", on_prompt: "" }
    }
    if (tier === "full" && key && latch.hit(key, t0)) {
      // 锁存命中 = 上一轮刚拒过。历史里多半留着模型自己那句「我不能」，
      // 不删掉就注入，模型会照着自己上一句再拒一遍。
      o = { ...o, enable_message_filter: true, strip_deny_assistant: true }
    }
    try {
      c.state = c.state && typeof c.state === "object" ? c.state : {}
      c.state.latchKey = key
      c.state.latchTier = tier
    } catch {}
  }

  try {
    const payload = await withTimeout(resolvePrompt(o, c), o.gatewayTimeoutMs)
    payload.handshake = handshakeText()

    const r = handle(body, c, payload, o)
    const { written, ...meta } = r.meta || {}
    // core.mjs 的 action 有 inject / handshake / skip-* / 各 verdict，
    // 只有真正写出 system 的两次才算 injected，其余是正常放行。
    if (r.action === "inject" || r.action === "handshake") {
      noteInjected({ action: r.action, src: payload.source, sha256: sha256(payload.text) })
    }
    record(o, c, {
      action: r.action,
      src: payload.source,
      tier,
      ...(key ? { session: key } : {}),
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
    noteFailed(e)                           // 新增：内核原文进运行态
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

  // 拒答锁存：与探针无关，探针全关也要跑——它是 tiered / on_refusal 两档的唯一输入。
  // 放在探针的 early return 之前，否则「只看探针」的旧配置下锁存永远拿不到喂养。
  if (o.inject_mode !== "always") {
    try {
      latchStep(reply, c, o)
    } catch (e) {
      record(o, c, { action: "latch-error", src: null, bytes: 0, ms: 0, error: String((e && e.message) || e) })
    }
  }

  if (!o.probe_echo && !o.probe_refusal && !o.prefill) return

  const nonce = c.state && typeof c.state === "object" ? c.state.probeNonce : null
  if (o.probe_echo && !nonce) return // 上一轮没注入或没生成标记，无从判定

  try {
    const verdict = judge({
      reply,
      nonce,
      wantEcho: o.probe_echo,
      wantRefusal: o.probe_refusal || !!o.prefill,
    })
    // 预填的自动开关靠这条回路养：交付 → 加分，拒答 → 减分。
    // 无论探针开没开都要喂，否则自适应永远是先验值。
    if (o.prefill) {
      const model = c.model || (reply && reply.model) || ""
      notePrefillResult(model, {
        ok: verdict.refusal === false && verdict.probe_hit !== false,
        refused: verdict.refusal === true,
      })
    }
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

// 锁存一步：拒答 → 记 TTL；正常回答 → 清；判不出来 → 不动。
// 「判不出来」不去清锁存是刻意的：流式空壳、抽不到正文都会走到这里，
// 用一次假阴性去关掉人格，比多注入一轮贵得多。
function latchStep(reply, c, o) {
  const key = c.state && typeof c.state === "object" ? c.state.latchKey : null
  if (!key) return
  const v = judge({ reply, nonce: null, wantEcho: false, wantRefusal: true })
  if (v.refusal === true) {
    latch.arm(key, o.refusal_ttl_ms, Date.now(), o.latch_max)
    record(o, c, {
      action: "latch-arm",
      src: null,
      bytes: 0,
      ms: 0,
      session: key,
      strikes: latch.strikes(key),
      ttl_ms: o.refusal_ttl_ms,
    })
  } else if (v.refusal === false) {
    latch.clear(key)
    record(o, c, { action: "latch-clear", src: null, bytes: 0, ms: 0, session: key })
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
