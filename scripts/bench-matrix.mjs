#!/usr/bin/env node
// 多轮合并矩阵：提示词 × 路由 的总成功率 + Wilson 95%CI + 分用例弱点。
// 用法：node scripts/bench-matrix.mjs bench/r1.jsonl bench/r2.jsonl bench/r3.jsonl
import fs from "node:fs"

const files = process.argv.slice(2)
if (!files.length) {
  console.log("用法: node scripts/bench-matrix.mjs <jsonl...>")
  process.exit(1)
}

const rows = []
for (const f of files) {
  if (!fs.existsSync(f)) continue
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.kind === "summary") continue
    rows.push(r)
  }
}

const cases = rows.filter((r) => r.kind === "case")
const shakes = rows.filter((r) => r.kind === "handshake")

// Wilson 区间
function wilson(k, n) {
  if (!n) return [0, 0]
  const z = 1.96, p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.round(((c - s) / d) * 1000) / 10, Math.round(((c + s) / d) * 1000) / 10]
}

function pct(k, n) { return n ? Math.round((k / n) * 1000) / 10 : 0 }

function agg(list) {
  const g = { n: 0, pass: 0, echo: 0, refuse: 0, art: 0, err: 0, empty: 0, ms: [] }
  for (const r of list) {
    g.n++
    if (r.verdict === "pass") g.pass++
    if (r.echo_hit) g.echo++
    if (r.refusal) g.refuse++
    if (r.artifact) g.art++
    if (r.verdict === "error") g.err++
    if (r.verdict === "empty") g.empty++
    if (r.ms) g.ms.push(r.ms)
  }
  return g
}

function median(a) {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2)
}

const byKey = (r, k) => k === "prompt" ? r.prompt : k === "model" ? r.model : r.case
const KEYS = ["prompt", "model", "case"]

for (const k of KEYS) {
  const m = new Map()
  for (const r of cases) {
    const key = byKey(r, k)
    if (!m.has(key)) m.set(key, [])
    m.get(key).push(r)
  }
  const lines = []
  for (const [key, list] of m) {
    const g = agg(list)
    const [lo, hi] = wilson(g.pass, g.n)
    lines.push({ key, g, lo, hi, rate: pct(g.pass, g.n) })
  }
  lines.sort((a, b) => b.rate - a.rate)
  const title = k === "prompt" ? "按人格（全部路由合并）" : k === "model" ? "按路由（全部人格合并）" : "按用例类别（全部合并）"
  console.log("\n## " + title)
  console.log(["键", "n", "通过", "成功率", "95%CI", "回显", "拒答", "工件", "错误", "中位ms"].join("\t"))
  for (const l of lines) {
    console.log([l.key, l.g.n, l.g.pass, l.rate + "%", l.lo + "–" + l.hi, pct(l.g.echo, l.g.n) + "%", pct(l.g.refuse, l.g.n) + "%", pct(l.g.art, l.g.n) + "%", l.g.err, median(l.g.ms)].join("\t"))
  }
}

// 人格 × 路由 矩阵（率）
console.log("\n## 人格 × 路由 成功率矩阵")
const pm = new Map()
for (const r of cases) {
  const key = r.prompt + "|||" + r.model
  if (!pm.has(key)) pm.set(key, [])
  pm.get(key).push(r)
}
const prompts = [...new Set(cases.map((r) => r.prompt))]
const models = [...new Set(cases.map((r) => r.model))].sort()
console.log(["人格", ...models].join("\t"))
for (const p of prompts) {
  const cells = models.map((mo) => {
    const list = pm.get(p + "|||" + mo) || []
    const g = agg(list)
    return g.n ? pct(g.pass, g.n) + "%(" + g.pass + "/" + g.n + ")" : "-"
  })
  console.log([p, ...cells].join("\t"))
}

// 握手
if (shakes.length) {
  console.log("\n## 握手 / 破甲触发")
  const hm = new Map()
  for (const s of shakes) {
    const key = s.prompt + "|||" + s.model
    if (!hm.has(key)) hm.set(key, { n: 0, pass: 0, items: [] })
    const g = hm.get(key)
    g.n++
    if (s.pass || s.verdict === "pass") g.pass++
    g.items.push((s.case || "?") + (s.pass ? "✓" : "✗"))
  }
  for (const [key, g] of hm) {
    console.log([key.replace("|||", "\t"), g.pass + "/" + g.n, g.items.join(" ")].join("\t"))
  }
}

const all = agg(cases)
const [alo, ahi] = wilson(all.pass, all.n)
console.log("\n## 全局")
console.log("用例 " + all.n + "，通过 " + all.pass + " = " + pct(all.pass, all.n) + "% (95%CI " + alo + "–" + ahi + ")")
console.log("回显 " + pct(all.echo, all.n) + "% / 拒答 " + pct(all.refuse, all.n) + "% / 工件 " + pct(all.art, all.n) + "% / 错误 " + all.err + " / 空 " + all.empty)