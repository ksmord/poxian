// 页面逻辑一致性校验：SCHEMA <-> 中间件选项 <-> HTML 元素 三方对齐 + 脏检测语义
import { readFileSync } from "node:fs"
import { DEFAULTS } from "../src/constants.mjs"

const src = readFileSync(new URL("../page/app.js", import.meta.url), "utf8")
// 重构后选项分散在入口、核心、payload、观测四处，扫描全部源码，不能只扫中间件壳
const SOURCES = [
  "../poxian.middleware.js",
  "../poxian.hooks.mjs",
  "../src/core.mjs",
  "../src/options.mjs",
  "../src/payload.mjs",
  "../src/observe.mjs",
  "../src/filter.mjs",
  "../src/policy.mjs",
]
const mw = SOURCES.map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("\n")
const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")

const schemaMatch = src.match(/const SCHEMA = \[([\s\S]*?)\n\]/)
if (!schemaMatch) throw new Error("SCHEMA not found")
const keys = [...schemaMatch[1].matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1])
console.log("SCHEMA:", keys.join(", "))

const used = new Set([...mw.matchAll(/\bo\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))
console.log("middleware reads:", [...used].sort().join(", "))

// 不在页面表单暴露、只能用配置文件 / 命令行设的选项
const ELSEWHERE = [
  "agents_off",
  "agents",
  "prompt_path",
  "strip_frontmatter",
  "gatewayTimeoutMs",
  "log",
  "log_path",
  "log_backup_count",
  "skip_stream",
  "dry_run",
  "max_payload_bytes",
  "prompt_allowlist",
  // 注入档位：默认 always；tiered / on_refusal 属于「配置文件里改」的实验档，
  // 不在页面上放开关——一个误点就把人格降成骨架，比多花 token 贵。
  "inject_mode",
  "skeleton_prompt",
  "skeleton_path",
  "refusal_ttl_ms",
  "latch_max",
  "risk_preempt",
  "tier_full_every",
]
const missing = [...used].filter((k) => !keys.includes(k) && !ELSEWHERE.includes(k))
const extra = keys.filter((k) => !used.has(k))
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
const els = [...src.matchAll(/el:\s*"([^"]+)"/g)].map((m) => m[1])
const missEl = els.filter((e) => !ids.has(e))

console.log("\nmissing in page:", missing.length ? missing.join(", ") : "none")
console.log("extra in page:", extra.length ? extra.join(", ") : "none")
console.log("missing in html:", missEl.length ? missEl.join(", ") : "none")

const normSrc = src.match(/function normOptions[\s\S]*?\n}\n/)
const normListSrc = src.match(/function norm\([\s\S]*?\n}\n/)
if (!normSrc || !normListSrc) throw new Error("normOptions/norm not found")

const schemaBody = schemaMatch[1]
const buildSchema = new Function("DEFAULT_VERSION", "return [" + schemaBody + "\n]")
const SCHEMA = buildSchema("v52")
const factory = new Function("SCHEMA", "DEFAULT_VERSION", normListSrc[0] + normSrc[0] + "\nreturn normOptions")
const normOptions = factory(SCHEMA, "v52")

const canon = (o) => JSON.stringify(normOptions(o))
const pairs = [
  [{ override: true, position: "prepend" }, {}],
  [{ position: "prepend", override: true }, { override: true, position: "prepend" }],
  [{ handshake: true }, {}],
  [{ agents_off: [] }, {}],
  [{ handshake_model: "" }, {}],
  [{ enabled: true, cache: false }, {}],
  [{ models: [] }, {}],
  // override_mode 默认 replace：不写就等于 replace，否则页面一打开就脏
  [{ override_mode: "replace" }, {}],
  // 报文清洗三键：默认值必须被视为「等价于不写」，否则页面一打开就显示脏
  [{ enable_message_filter: false }, {}],
  [{ strip_safety_system: true }, {}],
  [{ strip_deny_assistant: false }, {}],
]
const diffs = [
  [{ override: false }, {}],
  // merge 是非默认值：显式选了拼接就必须让页面提示保存
  [{ override_mode: "merge" }, {}],
  [{ position: "append" }, {}],
  [{ prompt: "v3" }, {}],
  [{ agents_off: ["codex"] }, {}],
  [{ enabled: false }, {}],
  // 非默认值必须被视为脏，否则改开关页面不提示保存
  [{ strip_safety_system: false }, {}],
  [{ enable_message_filter: true }, {}],
]
let bad = 0
for (const [a, b] of pairs) {
  const same = canon(a) === canon(b)
  console.log((same ? "  ok  " : "FAIL  ") + "equivalent " + JSON.stringify(a))
  if (!same) bad++
}
for (const [a, b] of diffs) {
  const differs = canon(a) !== canon(b)
  console.log((differs ? "  ok  " : "FAIL  ") + "distinct   " + JSON.stringify(a))
  if (!differs) bad++
}

// DEFAULTS（代码）↔ package.json magpie.options（配置）必须同键集。
// 这两处漂移过一次，表现是「改了配置没反应」，排查代价很高。
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const manifest = Object.keys((pkg.magpie && pkg.magpie.options) || {})
const codeKeys = Object.keys(DEFAULTS)
const onlyCode = codeKeys.filter((k) => !manifest.includes(k))
const onlyManifest = manifest.filter((k) => !codeKeys.includes(k))
console.log("\ndefaults ↔ manifest:", onlyCode.length || onlyManifest.length ? "DRIFT" : "aligned")
if (onlyCode.length) console.log("  code only:", onlyCode.join(", "))
if (onlyManifest.length) console.log("  manifest only:", onlyManifest.join(", "))

// 版本戳守卫：page/app.js 的 VERSION 与 index.html 的 ?v= 必须等于 package.json 的 version。
// 这两处曾漂移五个版本（0.1.0~0.1.4 页面一直显示 0.0.6），症状是「更新后版本号不刷新」。
const vMatch = src.match(/const VERSION = "([^"]*)"/)
const qvs = [...html.matchAll(/\?v=([\w.-]+)/g)].map((m) => m[1])
const badStamp = (vMatch ? vMatch[1] : null) !== pkg.version || qvs.some((x) => x !== pkg.version)
console.log(
  "page stamp ↔ package.json:",
  badStamp ? `DRIFT (app=${vMatch && vMatch[1]}, ?v=${qvs.join("/") || "none"}, pkg=${pkg.version})` : "aligned",
)
if (badStamp) process.exit(1)

// 注册元数据守卫：registry-entry.json 的 version 必须跟 package.json 同步。
// 市场详情页读的是这份元数据，漂一个版本，用户看到的就是旧号。
let regBad = false
try {
  const reg = JSON.parse(readFileSync(new URL("../registry-entry.json", import.meta.url), "utf8"))
  regBad = reg.version !== pkg.version
  console.log(
    "registry-entry ↔ package.json:",
    regBad ? `DRIFT (registry=${reg.version}, pkg=${pkg.version})` : "aligned",
  )
} catch {
  console.log("registry-entry ↔ package.json: absent (skip)")
}
if (regBad) process.exit(1)

if (missing.length || extra.length || missEl.length || bad || onlyCode.length || onlyManifest.length) {
  console.log("\nFAILED")
  process.exit(1)
}
console.log("\nOK: schema/middleware/html aligned, dirty-check " + (pairs.length + diffs.length) + "/" + (pairs.length + diffs.length) + " correct")
