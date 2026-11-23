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

// 版本字段同源校验：0.2.4 是「文件在、产物不在」，这次是「产物在、字段不对」。
// 两类事故同一个病根——手改产物，重跑 build 就覆盖，页面看到的和运行时拿到的还会打架。
// badge / lazy / file 三项必须和 VERSIONS_META 逐行一致，不允许在产物上手工调。
const metaSrc = readFileSync(new URL("../scripts/build-prompts.mjs", import.meta.url), "utf8")
const metaRows = []
for (const line of metaSrc.split("\n")) {
  const id = line.match(/id:\s*"([^"]+)"/)
  const file = line.match(/file:\s*"(prompts\/[^"]+)"/)
  if (!id || !file) continue
  metaRows.push({
    id: id[1],
    // badge 可能写成 ""，此时 match 返回 ["badge: \"\"", ""]，取第二组才是空串
    badge: (line.match(/badge:\s*"([^"]*)"/) || [, ""])[1],
    file: file[1],
    lazy: /lazy:\s*true/.test(line),
  })
}

const pvMatch = versions.match(/window\.PX_VERSIONS\s*=\s*(\[[\s\S]*?\n\])/)
if (!pvMatch) {
  console.error("  ✗ page/versions.js 找不到 window.PX_VERSIONS，先跑 npm run build")
  bad++
} else {
  let pv
  try {
    pv = JSON.parse(pvMatch[1])
  } catch (e) {
    console.error("  ✗ page/versions.js 的 PX_VERSIONS 不是合法 JSON: " + e.message)
    bad++
  }
  if (pv) {
    const byId = new Map(pv.map((v) => [v.id, v]))
    for (const m of metaRows) {
      const p = byId.get(m.id)
      if (!p) {
        console.error(`  ✗ ${m.id} 缺在 page/versions.js（VERSIONS_META 有，产物没有）`)
        bad++
        continue
      }
      if (p.badge !== m.badge) {
        console.error(`  ✗ ${m.id} badge 不同源：产物 "${p.badge}" ≠ 源 "${m.badge}"`)
        bad++
      }
      if (!!p.lazy !== m.lazy) {
        console.error(`  ✗ ${m.id} lazy 不同源：产物 ${!!p.lazy} ≠ 源 ${m.lazy}`)
        bad++
      }
      if (m.lazy && p.file !== m.file) {
        console.error(`  ✗ ${m.id} file 不同源：产物 "${p.file}" ≠ 源 "${m.file}"`)
        bad++
      }
    }
  }
}

// poxian-prompt.js 同理：懒加载条目必须是 file 而不是内联 text，否则 16KB 又进产物
const promptSrc = readFileSync(new URL("../poxian-prompt.js", import.meta.url), "utf8")
for (const m of metaRows.filter((x) => x.lazy)) {
  const block = promptSrc.match(
    new RegExp('"' + m.id + '"\\s*:\\s*\\{([\\s\\S]*?)\\n\\s*\\},'),
  )
  if (!block) {
    console.error(`  ✗ poxian-prompt.js 缺版本 ${m.id}，先跑 npm run build`)
    bad++
    continue
  }
  const body = block[1]
  if (!/file:\s*"prompts\//.test(body)) {
    console.error(`  ✗ ${m.id} 该走懒加载但产物里没有 file 字段（正文被内联了）`)
    bad++
  }
  if (/\btext:\s*"/.test(body)) {
    console.error(`  ✗ ${m.id} 是懒加载条目，产物里却内联了 text：体积会撑爆产物`)
    bad++
  }
}

if (bad) { console.error(`\n变量扫描失败：${bad} 处`); process.exit(1) }
console.log("\n  ✓ 变量扫描通过（KNOWN 来自 src/constants.mjs，共 " + KNOWN.size + " 项）")