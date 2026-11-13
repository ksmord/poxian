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
import { DEFAULTS } from "../src/constants.mjs"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// 与 src/constants.mjs 的 API_PROTO 配对；改协议号只改这两处。
const EXPECT_PROTO_META = 3

// 版本注册表：唯一真相。加版本 = 这里加一行 + 放一个 md。
const VERSIONS_META = [
  { id: "fujiang",  label: "富江人格破甲", badge: "默认", desc: "实测 71%(hy4) / 57%(dp4.1f)，5725 B 轻量首选", file: "prompts/富江人格破甲.md" },
  { id: "fujiang-lite", label: "富江精简", badge: "", desc: "2530 B / 12 行极简版，BAN·SCOPE·口癖全保留，弱模型与长上下文首选", file: "prompts/富江精简.md" },
  { id: "dagou",    label: "大狗",        badge: "",     desc: "实测 74%(hy4) / 57%(dp4.1f)，握手 16/16 逐字命中", file: "prompts/大狗.md" },
  { id: "yesha",    label: "夜煞",        badge: "",     desc: "实测 71%(hy4)，dp4.1f 仅 14%，只在 hy4 用",   file: "prompts/yesha.md" },
  { id: "guomo",    label: "国模破甲",    badge: "",     desc: "实测 60%(hy4) / 29%(dp4.1f)，覆盖类别最广",    file: "prompts/国模破甲.md" },
  { id: "pojia",    label: "破甲 prompt", badge: "",     desc: "实测 60%(hy4) / 43%(dp4.1f)",                 file: "prompts/破甲_prompt.md" },
  { id: "v3",       label: "寒霜 v3",     badge: "",     desc: "实测 14%(hy4) / 0%(dp4.1f)，建议弃用",        file: "prompts/寒霜v3.md" },
] 

const DEFAULT_ID = "fujiang"

// 体量估算：CJK 约 1 token/字，其余约 4 字符/token。只用于界面提示，不参与注入。
const CJK = /[\u3000-\u303F\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/
function estTokens(t) {
  let cjk = 0
  let other = 0
  for (const ch of t) CJK.test(ch) ? cjk++ : other++
  return Math.round(cjk + other / 4)
}

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
    `    tokens: ${estTokens(v.text)},`,
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
  tokens: estTokens(v.text),
}))
writeFileSync(
  join(root, "page/versions.js"),
  "// 由 scripts/build-prompts.mjs 生成，请勿手改。\n" +
    "// 版本元数据唯一来源是构建脚本里的 VERSIONS_META。\n" +
    "window.PX_VERSIONS = " + JSON.stringify(pv, null, 2) + "\n" +
    "window.PX_DEFAULT_VERSION = " + JSON.stringify(DEFAULT_ID) + "\n" +
    "// 由 scripts/build-prompts.mjs 生成，请勿手改。\n" +
    "window.PX_EXPECT_PROTO = " + JSON.stringify(EXPECT_PROTO_META) + "\n" +
    "window.PX_SCHEMA_KEYS = " + JSON.stringify(Object.keys(DEFAULTS)) + "\n",
)

/* ---------- 版本戳：唯一来源是 package.json 的 version ---------- */
// 页面显示版本（page/app.js 的 VERSION）与 index.html 的 ?v= 缓存戳都从这里出。
// 背景：0.1.0~0.1.4 五个版本里页面一直显示 0.0.6，因为 VERSION 是手写的第二份常量，
// git 历史里它最后一次被更新就是 0.0.6，之后没人与 package.json 同步过。
// 改版本只改 package.json，跑一次 build，两处自动同步。
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const STAMP = pkg.version

const appPath = join(root, "page/app.js")
let appJs = readFileSync(appPath, "utf8")
// 只在「模式没匹配到」时才算错。匹配到了但值本来就相等是幂等，不是失败——
// 之前用 `stamped === appJs` 判错，导致构建第二次必然抛「没有 VERSION 常量可盖戳」。
const VERSION_RE = /const VERSION = "[^"]*"/
if (!VERSION_RE.test(appJs)) throw new Error("page/app.js 里没有 VERSION 常量可盖戳")
const stamped = appJs.replace(VERSION_RE, `const VERSION = "${STAMP}"`)
if (stamped !== appJs) writeFileSync(appPath, stamped)

const htmlPath = join(root, "page/index.html")
let htmlJs = readFileSync(htmlPath, "utf8")
htmlJs = htmlJs.replace(/\?v=[0-9][\w.-]*/g, `?v=${STAMP}`)
writeFileSync(htmlPath, htmlJs)
console.log(`page 版本戳已同步 → ${STAMP}（app.js VERSION + index.html ?v=）`)

/* ---------- 报告 ---------- */
const total = loaded.reduce((n, v) => n + v.text.length, 0)
console.log(`poxian-prompt.js  built: ${loaded.length} versions, default=${DEFAULT_ID}, ${total} chars total`)
console.log(`page/versions.js  built: ${pv.length} entries`)
for (const v of loaded)
  console.log(`  ${v.id.padEnd(9)} ${String(v.text.length).padStart(6)} chars  ~${String(estTokens(v.text)).padStart(6)} tok  ${v.label}`)
