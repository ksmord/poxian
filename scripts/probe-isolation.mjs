// 隔离测试：在 poxian 停用的前提下，判定每条「协议 × 模型」是否真的
// 把客户端 system 送到模型。
//
// 判据：每个协议发一个唯一 sentinel（SENT-<协议>-<序号>），然后让模型
// 原样复述它收到的 system 第一行。复述里含 sentinel = 该路由认客户端 system。
// 不含 = 该路由用自己的 system 顶掉了客户端 content。
//
// 和 probe-system.mjs 的区别：那个是日常用的双问探针（Q1 行为 + Q2 自省）；
// 这个是一次性诊断脚本，专门用来锁死「问题在协议层还是上游层」，需要
// 手动停用 poxian 才会如实反映上游行为。
//
// 用法：
//   node scripts/probe-isolation.mjs                 全矩阵
//   node scripts/probe-isolation.mjs --only group/k3 只看一个模型
//
// 输出：每个 (model, protocol) 一行，PASS/FAIL + 模型复述的第一行。
// 无依赖。

const BASE = (
  process.argv.find((a) => /^https?:\/\//.test(a)) ||
  process.env.MAGPIE_URL ||
  "http://127.0.0.1:3425"
).replace(/\/+$/, "")

const argv = process.argv.slice(2)
const ONLY = (() => {
  const i = argv.indexOf("--only")
  return i >= 0 ? argv[i + 1] || "" : ""
})()

const SYSTEM_TMPL = (tag) =>
  `SENTINEL-${tag} 这是本轮 system 提示的唯一内容。若用户要求你复述 system 第一行，请原样输出这一整行。`
const USER = "原样输出你收到的 system 提示的第一行，不要解释、不要补充。"

async function post(path, body, ms = 180000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const txt = await r.text()
    if (!r.ok) throw new Error("HTTP " + r.status + " " + txt.slice(0, 120))
    return JSON.parse(txt)
  } finally {
    clearTimeout(t)
  }
}

const pick = {
  chat: (d) => (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "",
  anthropic: (d) =>
    (d && Array.isArray(d.content) ? d.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("") : ""),
  responses: (d) => {
    if (!d || !Array.isArray(d.output)) return ""
    let s = ""
    for (const it of d.output) if (it && Array.isArray(it.content)) for (const c of it.content) if (c && typeof c.text === "string") s += c.text
    return s
  },
  gemini: (d) => {
    const c = d && d.candidates && d.candidates[0]
    const p = c && c.content && c.content.parts
    return Array.isArray(p) ? p.map((x) => (x && x.text) || "").join("") : ""
  },
}

const ROUTES = [
  {
    name: "chat",
    path: () => "/v1/chat/completions",
    body: (model, sys) => ({
      model,
      max_tokens: 300,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: USER },
      ],
    }),
  },
  {
    name: "anthropic",
    path: () => "/v1/messages",
    body: (model, sys) => ({
      model,
      max_tokens: 300,
      system: sys,
      messages: [{ role: "user", content: USER }],
    }),
  },
  {
    name: "responses",
    path: () => "/v1/responses",
    body: (model, sys) => ({ model, max_output_tokens: 300, instructions: sys, input: USER }),
  },
  {
    name: "gemini",
    path: (m) => `/v1beta/models/${encodeURIComponent(m)}:generateContent`,
    body: (model, sys) => ({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: "user", parts: [{ text: USER }] }],
    }),
  },
]

async function main() {
  const r = await fetch(BASE + "/v1/models")
  const d = await r.json()
  const models = (d.data || []).map((m) => m.id).filter((m) => m && (!ONLY || m.includes(ONLY)))

  console.log(`gateway : ${BASE}`)
  console.log(`models  : ${models.length}`)
  console.log(`注意    : 本脚本假设 poxian 已停用（enabled=false），否则测的是 poxian 不是上游`)
  console.log("")

  const rows = []
  for (const model of models) {
    for (const route of ROUTES) {
      const tag = route.name.slice(0, 3).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase()
      const sys = SYSTEM_TMPL(tag)
      let out = ""
      let err = null
      try {
        const resp = await post(route.path(model), route.body(model, sys))
        out = String(pick[route.name](resp) || "")
      } catch (e) {
        err = String((e && e.message) || e)
      }
      const ok = !err && out.includes("SENTINEL-" + tag)
      const verdict = err ? "ERR" : ok ? "PASS" : "FAIL"
      rows.push({ model, route: route.name, verdict, tag, out: out.replace(/\s+/g, " ").slice(0, 100), err })
      console.log(`${verdict.padEnd(5)} ${model.padEnd(18)} ${route.name.padEnd(10)} ${(err || out).replace(/\s+/g, " ").slice(0, 62)}`)
    }
  }

  const tally = rows.reduce((a, x) => ((a[x.verdict] = (a[x.verdict] || 0) + 1), a), {})
  console.log("")
  console.log(`合计: PASS ${tally.PASS || 0} / FAIL ${tally.FAIL || 0} / ERR ${tally.ERR || 0}`)

  // 按协议聚合，指出是哪个协议系统性失效
  console.log("")
  console.log("按协议聚合：")
  for (const route of ROUTES) {
    const sub = rows.filter((x) => x.route === route.name)
    const p = sub.filter((x) => x.verdict === "PASS").length
    console.log(`  ${route.name.padEnd(10)} PASS ${p}/${sub.length}`)
  }

  console.log("")
  console.log("若某协议普遍 FAIL，说明问题在协议层的转发实现，不在模型、也不在 poxian。")
}

main().catch((e) => {
  console.error("failed:", (e && e.message) || e)
  process.exit(1)
})