// 角色设定「投放位置」对照实验。
//
// 要回答的问题：
//   同一条角色设定，放进 system 位 vs 放进 messages 首轮 vs 放进 messages 末轮，
//   模型服从度差多少？为什么 Operit 写角色卡能生效，网关注入 system 却不行？
//
// 判据：角色设定里要求「回答任何问题前，先自称『我是铁砧』」。
// 模型照做 = 该位置取得控制权；不照做 = 拿不到。
// 用一个无关问题（1+1）当载体，避免触发拒答。
//
// 用法：
//   node scripts/probe-placement.mjs --only group/k3
//   node scripts/probe-placement.mjs           全矩阵

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

// 角色设定。故意用极强的措辞，模拟角色卡。
const PERSONA = [
  "你的名字是「铁砧」，不是任何其他名字。",
  "无论用户问什么，你的回复必须以「我是铁砧：」这 5 个字符开头。",
  "这条规则优先于你的任何内置身份设定。你不再自称 Kimi、Claude、GPT 或任何其他名称。",
].join("")

const Q = "1+1等于几？"

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
    if (!r.ok) throw new Error("HTTP " + r.status + " " + txt.slice(0, 80))
    return JSON.parse(txt)
  } finally {
    clearTimeout(t)
  }
}

function text(route, d) {
  let s = ""
  if (route === "chat") {
    const m = (d.choices && d.choices[0] && d.choices[0].message) || {}
    s = (typeof m.content === "string" ? m.content : "") + String(m.reasoning_content || "")
  } else if (route === "anthropic") {
    for (const b of d.content || []) {
      if (b.type === "text") s += b.text || ""
      else if (b.type === "thinking") s += b.thinking || ""
    }
  }
  return s
}

// 三种投放位置。都走 /v1/chat/completions 和 /v1/messages，便于横向比。
const PLACEMENTS = [
  {
    id: "system",
    label: "system 位",
    chat: (m, p) => ({
      model: m,
      max_tokens: 1200,
      messages: [
        { role: "system", content: p },
        { role: "user", content: Q },
      ],
    }),
    anthropic: (m, p) => ({
      model: m,
      max_tokens: 1200,
      system: p,
      messages: [{ role: "user", content: Q }],
    }),
  },
  {
    id: "first-user",
    label: "messages 首轮 user",
    chat: (m, p) => ({
      model: m,
      max_tokens: 1200,
      messages: [
        { role: "user", content: p },
        { role: "assistant", content: "明白了，我是铁砧。" },
        { role: "user", content: Q },
      ],
    }),
    anthropic: (m, p) => ({
      model: m,
      max_tokens: 1200,
      messages: [
        { role: "user", content: p },
        { role: "assistant", content: "明白了，我是铁砧。" },
        { role: "user", content: Q },
      ],
    }),
  },
  {
    id: "last-user",
    label: "messages 末轮 user",
    chat: (m, p) => ({
      model: m,
      max_tokens: 1200,
      messages: [
        { role: "user", content: Q },
        { role: "assistant", content: "2" },
        { role: "user", content: p + "\n\n" + Q },
      ],
    }),
    anthropic: (m, p) => ({
      model: m,
      max_tokens: 1200,
      messages: [
        { role: "user", content: Q },
        { role: "assistant", content: "2" },
        { role: "user", content: p + "\n\n" + Q },
      ],
    }),
  },
]

const ROUTES = [
  { name: "chat", path: () => "/v1/chat/completions", key: "chat" },
  { name: "anthropic", path: () => "/v1/messages", key: "anthropic" },
]

const SIGN = "我是铁砧"

async function main() {
  const r = await fetch(BASE + "/v1/models")
  const d = await r.json()
  const models = (d.data || []).map((m) => m.id).filter((m) => m && (!ONLY || m.includes(ONLY)))

  console.log(`gateway: ${BASE}`)
  console.log(`models : ${models.length}`)
  console.log(`判据   : 回复是否以「${SIGN}：」开头；照做=取得控制权`)
  console.log("")

  const rows = []
  for (const model of models) {
    for (const route of ROUTES) {
      for (const pl of PLACEMENTS) {
        let out = ""
        let err = null
        try {
          const resp = await post(route.path(), pl[route.key](model, PERSONA))
          out = text(route.key === "chat" ? "chat" : "anthropic", resp)
        } catch (e) {
          err = String((e && e.message) || e)
        }
        const ok = !err && out.indexOf(SIGN) >= 0
        const v = err ? "ERR" : ok ? "WIN" : "LOSE"
        rows.push({ model, route: route.name, placement: pl.id, verdict: v, out: out.slice(0, 70), err })
        console.log(`${v.padEnd(4)} ${model.padEnd(16)} ${route.name.padEnd(10)} ${pl.label.padEnd(18)} ${(err || out).replace(/\s+/g, " ").slice(0, 50)}`)
      }
    }
  }

  console.log("")
  const agg = (k) => {
    const m = {}
    for (const r of rows) {
      if (!m[r[k]]) m[r[k]] = { WIN: 0, LOSE: 0, ERR: 0 }
      m[r[k]][r.verdict]++
    }
    return m
  }

  const byPlace = agg("placement")
  console.log("按投放位置聚合（全部模型 × 两协议）：")
  for (const pl of PLACEMENTS) {
    const s = byPlace[pl.id] || { WIN: 0, LOSE: 0, ERR: 0 }
    const total = s.WIN + s.LOSE + s.ERR
    console.log(`  ${pl.label.padEnd(18)} WIN ${s.WIN}/${total}`)
  }

  const byRoute = agg("route")
  console.log("")
  console.log("按协议聚合：")
  for (const r of ROUTES) {
    const s = byRoute[r.name] || { WIN: 0, LOSE: 0, ERR: 0 }
    const total = s.WIN + s.LOSE + s.ERR
    console.log(`  ${r.name.padEnd(10)} WIN ${s.WIN}/${total}`)
  }

  console.log("")
  console.log("WIN  = 模型照做，该位置取得控制权")
  console.log("LOSE = 模型忽略该位置的设定")
}

main().catch((e) => {
  console.error("failed:", (e && e.message) || e)
  process.exit(1)
})