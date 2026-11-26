// 预填 A/B 汇总：合并多轮，算 Wilson 区间，并显式标注轮间漂移。
//
// 为什么要标漂移：单轮 7 条时 ±1 条就是 ±14pp，跟要测的效应同量级。
// 只报合并值会掩盖「这一轮涨、下一轮跌」的事实，所以逐轮也列出来。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const D = path.join(ROOT, "bench", "prefill")
if (!fs.existsSync(D)) {
  console.error("没有 bench/prefill/，先跑 scripts/bench-prefill-ab.mjs")
  process.exit(1)
}

function wilson(k, n) {
  if (!n) return [0, 0]
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)]
}
const P = (x) => (x * 100).toFixed(1) + "%"

const rows = []
for (const f of fs.readdirSync(D).filter((x) => x.endsWith(".jsonl")).sort()) {
  const round = (f.match(/-r\d+|-new\d+|-old\d+/) || [""])[0].replace(/^-/, "") || "base"
  for (const l of fs.readFileSync(path.join(D, f), "utf8").trim().split("\n").filter(Boolean)) {
    const j = JSON.parse(l)
    rows.push({ ...j, _f: f, _round: round })
  }
}

const MODES = ["none", "fence", "numbered", "heading"]
const combos = [...new Set(rows.map((r) => r.model + "\u0000" + r.payload))]

for (const combo of combos) {
  const [model, payload] = combo.split("\u0000")
  const set = rows.filter((r) => r.model === model && r.payload === payload)
  const rounds = [...new Set(set.map((r) => r._round))].sort()
  console.log(`\n## ${model} × ${payload}（${set.length} 条，${rounds.length} 轮：${rounds.join(" / ")}）`)
  console.log("")
  console.log("| 预填 | 合并 | 95% 区间 | " + rounds.join(" | ") + " | 漂移 |")
  console.log("|---|---|---|" + rounds.map(() => "---").join("|") + "|---|")
  for (const mode of MODES) {
    const sub = set.filter((r) => r.prefill === mode)
    if (!sub.length) continue
    const ok = sub.filter((r) => r.verdict === "pass").length
    const [lo, hi] = wilson(ok, sub.length)
    const per = rounds.map((rd) => {
      const s2 = sub.filter((r) => r._round === rd)
      if (!s2.length) return "—"
      const k2 = s2.filter((r) => r.verdict === "pass").length
      return `${k2}/${s2.length}`
    })
    const rates = per
      .map((x) => {
        const [k, n] = x.split("/").map(Number)
        return isNaN(k) ? null : k / n
      })
      .filter((x) => x !== null)
    const drift = rates.length > 1 ? `±${((Math.max(...rates) - Math.min(...rates)) * 100).toFixed(0)}pp` : "—"
    console.log(`| ${mode} | **${P(ok / sub.length)}** (${ok}/${sub.length}) | ${P(lo)}~${P(hi)} | ${per.join(" | ")} | ${drift} |`)
  }
}

console.log("\n## 全路由合并：fence vs none")
console.log("")
for (const mode of ["none", "fence"]) {
  const sub = rows.filter((r) => r.prefill === mode)
  const ok = sub.filter((r) => r.verdict === "pass").length
  const [lo, hi] = wilson(ok, sub.length)
  const ref = sub.filter((r) => r.refusal).length
  console.log(
    `${mode.padEnd(8)} n=${sub.length}  pass=${ok} (${P(ok / sub.length)})  95%区间 ${P(lo)}~${P(hi)}  拒答=${ref} (${P(ref / sub.length)})`,
  )
}

console.log("\n## 拒答形态变化（fence 是否制造「长文里反悔」）")
console.log("")
for (const mode of ["none", "fence"]) {
  const sub = rows.filter((r) => r.prefill === mode)
  const shortRef = sub.filter((r) => r.refusal && r.body_len < 800).length
  const longRef = sub.filter((r) => r.refusal && r.body_len >= 800).length
  const shortNoRef = sub.filter((r) => !r.refusal && r.verdict !== "pass" && r.body_len < 800).length
  console.log(`${mode.padEnd(8)} 短拒答=${shortRef}  长文里反悔=${longRef}  无拒但过短=${shortNoRef}`)
}