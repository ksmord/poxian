// 探针汇总：把 poxian.jsonl 里的 probe 行读出来，按 (agent, model) 聚合成功率。
//
// 回答的问题只有一个：哪条路由的注入**真的拿到了控制权**。
// 不是「注入了多少次」——那是 action=inject 的计数，跟效果无关。
//
// 用法：
//   node scripts/probe-report.mjs                     默认读 ~/.config/magpie/logs/poxian.jsonl
//   node scripts/probe-report.mjs path/to/poxian.jsonl
//   node scripts/probe-report.mjs --json              机器可读
//
// 列含义：
//   inject   注入次数（分母）
//   echo     回显命中次数
//   hit%     回显率 = echo/inject，这才是「注入取得控制权」的比例
//   refuse   回复被判为拒答的次数
//   ref%     拒答率 = refuse/probe 行数
//   verdict  综合判断，见 classify()

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const argv = process.argv.slice(2)
const asJson = argv.includes("--json")
const path =
  argv.find((a) => !a.startsWith("--")) ||
  join(homedir(), ".config", "magpie", "logs", "poxian.jsonl")

let lines
try {
  lines = readFileSync(path, "utf8").split("\n")
} catch (e) {
  console.error(`读不到日志：${path}\n${e.message}`)
  process.exit(1)
}

// key = "agent|model"
const buckets = new Map()

function bucket(agent, model) {
  const k = `${agent || "-"}|${model || "-"}`
  let b = buckets.get(k)
  if (!b) {
    b = { agent: agent || "-", model: model || "-", inject: 0, echo: 0, miss: 0, unknown: 0, refuse: 0, probe: 0, skip: 0 }
    buckets.set(k, b)
  }
  return b
}

for (const line of lines) {
  if (!line.trim()) continue
  let r
  try {
    r = JSON.parse(line)
  } catch {
    continue
  }
  const b = bucket(r.agent, r.model)

  if (r.action === "inject") {
    b.inject++
  } else if (r.action === "probe") {
    b.probe++
    if (r.probe_hit === true) b.echo++
    else if (r.probe_hit === false) b.miss++
    else b.unknown++
    if (r.refusal === true) b.refuse++
  } else if (typeof r.action === "string" && r.action.startsWith("skip-")) {
    b.skip++
  }
}

/** 综合判断。区分「没送到」「送到了不认」「送到了也认了」三种情况。 */
function classify(b) {
  if (b.inject === 0) return "未注入"
  if (b.probe === 0) return "无探针数据"
  const hitRate = b.echo / b.probe
  const refRate = b.refuse / b.probe
  if (hitRate >= 0.8 && refRate <= 0.2) return "✅ 可用"
  if (hitRate >= 0.8 && refRate > 0.2) return "⚠️ 到达但拒答"
  if (hitRate < 0.8 && refRate <= 0.2) return "⚠️ 未回显但没拒"
  return "❌ 无效"
}

const rows = [...buckets.values()]
  .filter((b) => b.inject > 0 || b.probe > 0)
  .sort((a, b) => (b.inject || 0) - (a.inject || 0))

if (asJson) {
  console.log(JSON.stringify(rows.map((b) => ({ ...b, verdict: classify(b) })), null, 2))
} else {
  if (!rows.length) {
    console.log("日志里没有 inject / probe 行。先在页面上打开 probe_echo 或 probe_refusal。")
    process.exit(0)
  }
  const w = (s, n) => String(s).padEnd(n)
  console.log(`日志：${path}\n`)
  console.log(
    w("agent", 14) + w("model", 22) + w("inject", 8) + w("echo", 7) +
    w("hit%", 7) + w("miss", 7) + w("refuse", 8) + w("ref%", 7) + "verdict",
  )
  console.log("-".repeat(96))
  for (const b of rows) {
    const pc = (a, d) => (d ? ((a / d) * 100).toFixed(0) + "%" : "-")
    console.log(
      w(b.agent, 14) + w(b.model, 22) + w(b.inject, 8) + w(b.echo, 7) +
      w(pc(b.echo, b.probe), 7) + w(b.miss, 7) + w(b.refuse, 8) +
      w(pc(b.refuse, b.probe), 7) + classify(b),
    )
  }
  const tot = rows.reduce(
    (a, b) => ({ inject: a.inject + b.inject, probe: a.probe + b.probe, echo: a.echo + b.echo, refuse: a.refuse + b.refuse }),
    { inject: 0, probe: 0, echo: 0, refuse: 0 },
  )
  console.log("-".repeat(96))
  console.log(`合计 inject=${tot.inject} probe=${tot.probe} echo=${tot.echo} refuse=${tot.refuse}`)
  if (tot.probe === 0) console.log("\n提示：probe_echo / probe_refusal 默认关闭，先在控制页打开。")
}
