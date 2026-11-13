// scripts/check-vars.mjs —— 变量/畸形占位扫描，前置到 npm run check
//
// 为什么：fujiang 把 unknownVariables / malformedVariables 同时挂在 /config 和 /preview，
// 而不是只挂预览——未知变量会让内核 renderPrompt 每一轮都抛错，用户一进设置页就该看到。
// poxian 的 prompts/*.md 目前用不到模板变量，但 build-prompts.mjs 会把它编进
// poxian-prompt.js 与 versions.js；一旦引入 {{NAME}}，写错名字就是每一轮请求都挂。
// 已知名一律从真实装配里取，绝不写死（fujiang 的 refreshKnownVars 走 assemble({}) 同理）。

import { readFileSync, readdirSync } from "node:fs"
import { DEFAULTS, ACTIVATION, MARK } from "../src/constants.mjs"

// 已知名从真实常量动态取；新增选项/激活词自动进入白名单，不需要维护第二份清单
const KNOWN = new Set([
  ...Object.keys(DEFAULTS),
  ...(Array.isArray(ACTIVATION) ? ACTIVATION : [ACTIVATION]),
  "MODEL", "AGENT", "DATE", "PROTO", "VERSION",
])

const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const MALFORMED = /\{\{(?![^{}]*\}\})/g
const dir = new URL("../prompts/", import.meta.url)
let bad = 0

for (const f of readdirSync(dir)) {
  if (!/\.(md|txt)$/i.test(f)) continue
  const text = readFileSync(new URL(f, dir), "utf8")
  const used = [...text.matchAll(VAR)].map((m) => m[1])
  const unknown = [...new Set(used)].filter((v) => !KNOWN.has(v))
  const malformed = (text.match(MALFORMED) || []).length
  const hasMark = text.includes(MARK)

  if (unknown.length || malformed) {
    console.error(`  ✗ prompts/${f}`)
    if (unknown.length) console.error(`      未知变量: ${unknown.join(", ")}`)
    if (malformed) console.error(`      未闭合的 {{ : ${malformed} 处`)
    bad++
  } else {
    console.log(`  ✓ prompts/${f}${hasMark ? " (含幂等标记)" : ""}`)
  }
}

// 生成物与源必须同源：改了 md 忘了 build，页面拿到的还是旧 poxian-prompt.js
const versions = readFileSync(new URL("../page/versions.js", import.meta.url), "utf8")
for (const key of ["PX_EXPECT_PROTO", "PX_SCHEMA_KEYS"]) {
  if (!new RegExp("window\\." + key + "\\s*=").test(versions)) {
    console.error("  ✗ page/versions.js 缺 window." + key + "，先跑 npm run build")
    bad++
  }
}

if (bad) { console.error(`\n变量扫描失败：${bad} 处`); process.exit(1) }
console.log("\n  ✓ 变量扫描通过（KNOWN 来自 src/constants.mjs，共 " + KNOWN.size + " 项）")
