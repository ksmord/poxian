// 校验 src/routefit.mjs 的观测表与 bench/MATRIX.md 是否逐格一致。
//
// ── 为什么需要这个脚本 ────────────────────────────────────────────
// ENGINEERING-NOTES §7「文档漂移」：配置项、文档、代码三处必须同源，
// 而且**必须逐键比默认值，不能只比键名集合**。第 3 条（值漂移）最难发现也最伤人。
// 这张观测表是「哪条路由配哪份载荷」的唯一真相，一旦手抄错一格，
// 表现就是「某条路由莫名其妙用了最差的载荷」——而且不会有任何报错。
//
// ── 这个脚本回答三个问题 ──────────────────────────────────────────
//   1. MATRIX.md 里有、routefit.mjs 里没有的格（**漏抄**）
//   2. routefit.mjs 里有、MATRIX.md 里没有的格（**凭空造数**）
//   3. 两边都有但通过数/样本数不同的格（**值漂移**）—— 最伤人
//
// 跑法：node scripts/check-routefit.mjs

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { observedTable } from "../src/routefit.mjs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// MATRIX.md 的人格名 → routefit.mjs 的载荷 id。
// 显式列出，不用模糊匹配：人格名里带「破甲」「人格」这类词，猜错一次就是静默错。
const NAME_TO_ID = {
  "yesha": "yesha",
  "富江人格破甲": "fujiang",
  "富江精简": "fujiang-lite",
  "大狗": "dagou",
  "国模破甲": "guomo",
  "破甲_prompt": "pojia",
  "寒霜v3": "v3",
  "小猫": "xiaomao",
}

// 从「人格 × 路由矩阵」那一节解析。只认形如 `50% (4/8)` 的格。
function parseMatrix(md) {
  const out = {} // route -> id -> { pass, n }
  const lines = md.split("\n")

  // 找矩阵表头：以 `| 人格 |` 开头且含 dp4.1f 的那一行
  let head = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith("|") && t.includes("人格") && t.includes("dp4.1f")) {
      head = i
      break
    }
  }
  if (head === -1) return out

  const cols = lines[head].split("|").map((s) => s.trim()).filter(Boolean)
  const routes = cols.slice(1) // 去掉「人格」列
  const routesNorm = routes.map((r) => r.replace(/^group\//, ""))

  for (let i = head + 2; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t.startsWith("|")) break
    const cells = t.split("|").map((s) => s.trim()).filter(Boolean)
    if (cells.length < 2) break

    const name = cells[0].replace(/\*\*/g, "")
    const id = NAME_TO_ID[name]
    if (!id) continue

    for (let c = 1; c < cells.length && c < routesNorm.length + 1; c++) {
      const m = cells[c].match(/\((\d+)\s*\/\s*(\d+)\)/)
      if (!m) continue
      const route = routesNorm[c - 1]
      if (!out[route]) out[route] = {}
      out[route][id] = { pass: Number(m[1]), n: Number(m[2]) }
    }
  }
  return out
}

const md = await readFile(join(root, "bench", "MATRIX.md"), "utf8")
const truth = parseMatrix(md)
const code = observedTable()

const problems = []

// 1 + 3：文档有、代码缺 / 值不同
for (const [route, row] of Object.entries(truth)) {
  for (const [id, { pass, n }] of Object.entries(row)) {
    const got = code[route] && code[route][id]
    if (!got) {
      problems.push(`漏抄：${route} × ${id} = ${pass}/${n}，routefit.mjs 里没有这一格`)
      continue
    }
    if (got.pass !== pass || got.n !== n) {
      problems.push(
        `值漂移：${route} × ${id} — MATRIX.md ${pass}/${n}（${((pass / n) * 100).toFixed(1)}%），` +
        `routefit.mjs ${got.pass}/${got.n}（${((got.pass / got.n) * 100).toFixed(1)}%）`
      )
    }
  }
}

// 2：代码有、文档缺
for (const [route, row] of Object.entries(code)) {
  for (const [id, { pass, n }] of Object.entries(row)) {
    if (!truth[route] || !truth[route][id]) {
      problems.push(`凭空造数：${route} × ${id} = ${pass}/${n}，MATRIX.md 里查不到这一格`)
    }
  }
}

const truthCells = Object.values(truth).reduce((a, r) => a + Object.keys(r).length, 0)
const codeCells = Object.values(code).reduce((a, r) => a + Object.keys(r).length, 0)

if (problems.length) {
  console.error(`✖ routefit 校验失败：${problems.length} 处不一致`)
  for (const p of problems) console.error("  " + p)
  process.exit(1)
}

console.log(`✓ routefit 校验通过：MATRIX.md ${truthCells} 格 / routefit.mjs ${codeCells} 格，逐格通过数·样本数全等`)