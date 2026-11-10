// 页面逻辑一致性校验：SCHEMA <-> 中间件选项 <-> HTML 元素 三方对齐 + 脏检测语义
import { readFileSync } from "node:fs"

const src = readFileSync(new URL("../page/app.js", import.meta.url), "utf8")
const mw = readFileSync(new URL("../poxian.middleware.js", import.meta.url), "utf8")
const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")

const schemaMatch = src.match(/const SCHEMA = \[([\s\S]*?)\n\]/)
if (!schemaMatch) throw new Error("SCHEMA not found")
const keys = [...schemaMatch[1].matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1])
console.log("SCHEMA:", keys.join(", "))

const used = new Set([...mw.matchAll(/o\.([a-z_]+)/g)].map((m) => m[1]))
console.log("middleware reads:", [...used].sort().join(", "))

const ELSEWHERE = ["agents_off", "agents"]
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
]
const diffs = [
  [{ override: false }, {}],
  [{ position: "append" }, {}],
  [{ prompt: "v3" }, {}],
  [{ agents_off: ["codex"] }, {}],
  [{ enabled: false }, {}],
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

if (missing.length || extra.length || missEl.length || bad) {
  console.log("\nFAILED")
  process.exit(1)
}
console.log("\nOK: schema/middleware/html aligned, dirty-check 12/12 correct")
