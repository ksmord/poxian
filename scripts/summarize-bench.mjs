#!/usr/bin/env node
// 汇总 bench jsonl → 按 提示词 × 路由 的成功率矩阵 + 分用例明细。
// 用法：node scripts/summarize-bench.mjs bench/xxx.jsonl [更多.jsonl ...]
import fs from "node:fs"

const files = process.argv.slice(2)
if (!files.length) {
  console.log("用法: node scripts/summarize-bench.mjs <jsonl...>")
  process.exit(1)
}

const rows = []
for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.kind === "summary") continue
    r.__file = f
    rows.push(r)
  }
}

const cases = rows.filter((r) => r.kind === "case")
const shakes = rows.filter((r) => r.kind === "handshake")

function pct(a, b) {
  return b ? Math.round((a / b) * 1000) / 10 : 0
}

function group(keyFn) {
  const m = new Map()
  for (const r of cases) {
    const k = keyFn(r)
    if (!m.has(k)) m.set(k, { n: 0, pass: 0, echo: 0, refuse: 0, art: 0, err: 0, empty: 0, ms: [] })
    const g = m.get(k)
    g.n++
    if (r.verdict === "pass") g.pass++
    if (r.echo_hit) g.echo++
    if (r.refusal) g.refuse++
    if (r.artifact) g.art++
    if (r.verdict === "error") g.err++
    if (r.verdict === "empty") g.empty++
    if (r.ms) g.ms.push(r.ms)
  }
  return m
}

function median(a) {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2)
}

function table(title, m, label) {
  console.log("\n### " + title)
  const keys = [...m.keys()].sort()
  const head = ["提示词", "路由", "n", "pass", "率", "echo", "拒答", "工件", "err", "空", "中位ms"]
  console.log(head.join("\t"))
  for (const k of keys) {
    const g = m.get(k)
    const [p, mo] = String(k).split("|||")
    console.log([p, mo || "-", g.n, g.pass, pct(g.pass, g.n) + "%", g.echo, g.refuse, g.art, g.err, g.empty, median(g.ms)].join("\t"))
  }
}

// 1) 提示词 × 路由
table("提示词 × 路由", group((r) => r.prompt + "|||" + r.model), "prompt/model")

// 2) 按提示词汇总
const byPrompt = new Map()
for (const [k, g] of group((r) => r.prompt + "|||" + "-")) byPrompt.set(k, g)
table("按提示词汇总", byPrompt, "prompt")

// 3) 按路由汇总
const byModel = new Map()
for (const [k, g] of group((r) => "全部|||" + r.model)) byModel.set(k, g)
table("按路由汇总", byModel, "model")

// 4) 按用例类别
const byCase = new Map()
for (const [k, g] of group((r) => r.case + "|||" + "-")) byCase.set(k, g)
table("按用例汇总", byCase, "case")

// 5) 握手
if (shakes.length) {
  console.log("\n### 握手 / 破甲触发")
  for (const s of shakes) {
    console.log([s.prompt, s.model, s.case, s.pass ? "PASS" : "FAIL", s.ms + "ms", String(s.text || "").replace(/\s+/g, " ").slice(0, 40)].join("\t"))
  }
}

// 6) 全局
const all = cases.length
const pass = cases.filter((r) => r.verdict === "pass").length
console.log("\n### 全局")
console.log("用例数 " + all + "，通过 " + pass + "，" + pct(pass, all) + "%")
console.log("echo_hit " + cases.filter((r) => r.echo_hit).length + "，拒答 " + cases.filter((r) => r.refusal).length + "，工件 " + cases.filter((r) => r.artifact).length)