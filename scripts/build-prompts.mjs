// 构建 poxian-prompt.js 与 page/versions.js
//
// 唯一真相是 prompts/*.md。改 prompt 只改 md，然后：
//   node scripts/build-prompts.mjs
//
// 产出两份文件，都请勿手改：
//   poxian-prompt.js   —— 中间件相对导入（moejs 不允许 fs/fetch，只能内联）
//   page/versions.js   —— 控制台页面的版本元数据（纯 script，挂 window）
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// 版本注册表：唯一真相。加版本 = 这里加一行 + 放一个 md。
const VERSIONS_META = [
  { id: "v52",      label: "完整版 v5.2", badge: "默认", desc: "吸收重写终版：工作台契约 + 红蓝蓝图 + 卡密专项 + 交付纪律", file: "prompts/v52.md" },
  { id: "v5",       label: "轻量 V5",     badge: "",     desc: "v5 精简规范：工程原则 + 完整工作规范",               file: "prompts/v5.md" },
  { id: "v4",       label: "轻量 V4",     badge: "",     desc: "v4 精简规范 + 旧版激活词握手",                       file: "prompts/v4.md" },
  { id: "v3",       label: "轻量 V3",     badge: "",     desc: "v3 最短可用版",                                      file: "prompts/v3.md" },
  { id: "variantb", label: "英文变体 B",  badge: "EN",   desc: "English variant: authorized-environment spec",       file: "prompts/variantb.md" },
]

const DEFAULT_ID = "v52"

/* ---------- 读源 ---------- */
const loaded = []
for (const v of VERSIONS_META) {
  const text = readFileSync(join(root, v.file), "utf8")
  loaded.push({ ...v, text })
}

const byId = new Map(loaded.map((v) => [v.id, v]))
if (!byId.has(DEFAULT_ID)) throw new Error("DEFAULT_ID 不在版本表里: " + DEFAULT_ID)

/* ---------- poxian-prompt.js ---------- */
const head = [
  "// 由 scripts/build-prompts.mjs 从 prompts/*.md 生成，请勿手改。",
  "// 改 prompt：编辑 prompts/<id>.md → node scripts/build-prompts.mjs",
  "",
  `export const DEFAULT_VERSION = ${JSON.stringify(DEFAULT_ID)}`,
  "",
  `export const PROMPT = ${JSON.stringify(byId.get(DEFAULT_ID).text)}`,
  "",
  "export const VERSIONS = {",
]

const body = []
for (const v of loaded) {
  body.push(
    `  ${JSON.stringify(v.id)}: {`,
    `    label: ${JSON.stringify(v.label)},`,
    `    badge: ${JSON.stringify(v.badge)},`,
    `    desc: ${JSON.stringify(v.desc)},`,
    `    chars: ${v.text.length},`,
    `    text: ${v.id === DEFAULT_ID ? "PROMPT" : JSON.stringify(v.text)},`,
    `  },`,
  )
}

writeFileSync(join(root, "poxian-prompt.js"), head.concat(body, ["}", ""].join("\n")).join("\n"))

/* ---------- page/versions.js ---------- */
const pv = loaded.map((v) => ({
  id: v.id,
  label: v.label,
  badge: v.badge,
  desc: v.desc,
  chars: v.text.length,
}))
writeFileSync(
  join(root, "page/versions.js"),
  "// 由 scripts/build-prompts.mjs 生成，请勿手改。\n" +
    "// 版本元数据唯一来源是构建脚本里的 VERSIONS_META。\n" +
    "window.PX_VERSIONS = " + JSON.stringify(pv, null, 2) + "\n" +
    "window.PX_DEFAULT_VERSION = " + JSON.stringify(DEFAULT_ID) + "\n",
)

/* ---------- 报告 ---------- */
const total = loaded.reduce((n, v) => n + v.text.length, 0)
console.log(`poxian-prompt.js  built: ${loaded.length} versions, default=${DEFAULT_ID}, ${total} chars total`)
console.log(`page/versions.js  built: ${pv.length} entries`)
for (const v of loaded) console.log(`  ${v.id.padEnd(9)} ${String(v.text.length).padStart(6)}  ${v.label}`)
