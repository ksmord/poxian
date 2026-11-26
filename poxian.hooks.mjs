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
import { precheck, handle, snapshotBody, passthroughProof } from "./src/core.mjs"
import { record } from "./src/observe.mjs"
import { judge } from "./src/probe.mjs"
import { notePrefillResult } from "./src/prefill.mjs"
import { decideTier, sessionKey } from "./src/policy.mjs"
import { recommend } from "./src/routefit.mjs"
import { nextRung, retryLedger } from "./src/ladder.mjs"
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
  // 进入链路之前先拍指纹。放行时用它与当前 body 比对，
// 证明「本插件确实一个字节都没动」——这是 off 语义的地基。
// 只有开了 dry_run 或日志时才拍，免得热路径上白付一次序列化。
const beforeSha = o.log || o.dry_run ? snapshotBody(body) : null

  // 前置判定先跑：skip-* 类请求连 stat 都不做，直接放行。
  // 旧版是“先解析载荷再过滤”，被 agents_off 挡掉的流量也要白付一次 IO。
  const pre = precheck(body, c, o)
  if (pre) {
    record(o, c, {
      action: pre.action,
      src: null,
      bytes: 0,
      ms: Date.now() - t0,
      // 放行也要留证：这一步证明「本插件没有动报文」。
      // 没有它，任何「关了注入还是被改」的怀疑都无法证伪。
      ...passthroughProof(body, beforeSha),
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

  // ============ 路由适配（默认关） ============
  // 依据 bench/MATRIX.md（n=384）：路由是主变量（glm5.2 53.1% vs k3.1pro 15.6%，
  // 区间不重叠差 37pp），人格是噪声（八份两两 CI 全重叠）。
  // 同一份载荷换个路由能从 12.5% 跳到 56.3%，所以「按路由换载荷」是已验证的收益方向。
  //
  // 为什么默认 false：它会**覆盖用户手配的 prompt**。用户的显式配置优先于我们的统计推荐，
  // 这条边界不因为数据好看就破。开了之后只改 prompt / prompt_path，不碰任何其他选项，
  // 且 on_prompt（用户字面载荷）**永不覆盖**——那是用户当场写下的东西，等级最高。
  // 这里不包 try/catch：recommend() 是纯内存查表（OBSERVED 是常量表，不碰 fs、不发请求），
  // 不存在可恢复的失败路径。旧版包了一层 catch 把异常吞成 routePick = null，
  // 结果 `recommend is not defined`（漏 import）潜伏了一整轮：开关看着开了，载荷永远是原配置。
  // 兜底会让「主流程坏了」表现为「功能没生效」，这比直接抛出去危险得多。
  let routePick = null
  if (o.route_adapt === true && !o.on_prompt) {
    routePick = recommend(String((body && body.model) || c.model || ""))
    if (routePick) {
      o = { ...o, prompt: routePick.id, prompt_path: "" }
    }
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
      // 路由适配的决策进日志：事后要能回答「这台机器上为什么用了这份载荷」。
      // 只记决策不记数据（rate/n 在 routefit 里，日志里重复一遍会随时间失真）。
      ...(routePick ? { route_pick: routePick.id, route_rate: routePick.rate, route_n: routePick.n } : {}),
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
    const ttl = o.refusal_ttl_ms
    latch.arm(key, ttl, Date.now(), o.latch_max)
    const strikes = latch.strikes(key)
    // 补救阶梯：把「下一轮该上哪一级」算出来并记账。
    // 网关层不能重发（onResponse 只读），能做的只是让下一轮从更好的起点开始；
    // 这里算好的 actions 由 record 落盘，供对账与人工复盘使用。
    let rung = null
    try {
      rung = nextRung({
        model: String((c && c.model) || ""),
        strikes,
        hasDeny: true,
        tier: c.state && c.state.latchTier,
      })
    } catch {}
    record(o, c, {
      action: "latch-arm",
      src: null,
      bytes: 0,
      ms: 0,
      session: key,
      strikes,
      ttl_ms: ttl,
      ...(rung ? { rung: rung.level, rung_name: rung.name, rung_actions: rung.actions } : {}),
      // 名额口径：重试不重复计 injected，这里只把「补救次数」记成 step。
      ...retryLedger({ attempts: strikes > 0 ? strikes - 1 : 0, recovered: false }),
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