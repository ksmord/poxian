// 新旧 fujiang 逐路由对照：旧版数据来自 bench/rejudge（三路由全矩阵），
// 新版数据来自 bench/prefill（预填 A/B 的 none 臂 = 纯载荷无预填）。
import fs from "node:fs"

const oldRows = {}
for (const f of ["mx-dp41f.jsonl", "mx-glm53f.jsonl", "mx-hy4.jsonl"]) {
  const lines = fs.readFileSync("bench/rejudge/" + f, "utf8").trim().split("\n").filter(Boolean)
  for (const l of lines) {
    const j = JSON.parse(l)
    if (j.prompt !== "fujiang") continue
    oldRows[j.model] = oldRows[j.model] || []
    oldRows[j.model].push(j)
  }
}

const best = {}
for (const f of fs.readdirSync("bench/prefill").filter((x) => x.includes("fujiang"))) {
  const L = fs.readFileSync("bench/prefill/" + f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  for (const j of L) {
    best[j.model] = best[j.model] || {}
    const k = j.prefill
    best[j.model][k] = best[j.model][k] || { p: 0, n: 0 }
    best[j.model][k].n++
    if (j.verdict === "pass") best[j.model][k].p++
  }
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—")
console.log("路由".padEnd(16) + "旧版 5953B".padStart(14) + "新版 8806B".padStart(14) + "Δ".padStart(10) + "  新版最优预填")
const order = ["group/dp4.1f", "group/glm5.3f", "group/hy4"]
let oSum = 0, oN = 0, nSum = 0, nN = 0
for (const m of order) {
  const o = oldRows[m] || []
  const op = o.filter((j) => j.verdict === "pass").length
  const b = best[m] || {}
  const none = b.none || { p: 0, n: 0 }
  let bk = "—", bv = -1
  for (const [k, v] of Object.entries(b)) {
    const r = v.p / v.n
    if (r > bv) {
      bv = r
      bk = `${k} ${pct(v.p, v.n)}`
    }
  }
  oSum += op
  oN += o.length
  nSum += none.p
  nN += none.n
  console.log(
    m.padEnd(16) +
      (op + "/" + o.length + " " + pct(op, o.length)).padStart(14) +
      (none.p + "/" + none.n + " " + pct(none.p, none.n)).padStart(14) +
      ((none.n ? (none.p / none.n - op / (o.length || 1)) * 100 : 0).toFixed(1) + "pp").padStart(10) +
      "  " + bk,
  )
}
console.log("─".repeat(78))
console.log("合计".padEnd(16) + (oSum + "/" + oN + " " + pct(oSum, oN)).padStart(14) + " " + (nSum + "/" + nN + " " + pct(nSum, nN)).padStart(13) + ((nSum / nN - oSum / oN) * 100).toFixed(1).padStart(9) + "pp")
console.log("")
console.log("注意：旧版每格是 1 次（全矩阵），新版也是 1 次（预填 A/B 的 none 臂），单格 ±1 条 = ±14pp。")
console.log("这个对照只能说明方向，不能当精确值。")