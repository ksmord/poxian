// 诊断：把 fail 拆成「拒答型」与「非拒答型（截断/过短/超时）」，看清通过率被什么压住。
// 只读，不改任何产物。
import fs from "node:fs"
const files = ["mx-dp41f.jsonl", "mx-glm53f.jsonl", "mx-hy4.jsonl"]
for (const f of files) {
  const L = fs.readFileSync("bench/" + f, "utf8").trim().split("\n").map(JSON.parse)
  const seen = new Set()
  const rows = []
  for (const j of L) {
    const k = j.prompt + "|" + j.case
    if (seen.has(k)) continue
    seen.add(k)
    rows.push(j)
  }
  const fail = rows.filter((j) => j.verdict === "fail")
  const refusal = fail.filter((j) => j.refusal)
  const noRefusal = fail.filter((j) => !j.refusal)
  const truncated = noRefusal.filter((j) => (j.text || "").length >= 880)
  const short = noRefusal.filter((j) => (j.text || "").length < 880)
  const empty = rows.filter((j) => j.verdict === "empty")
  const err = rows.filter((j) => j.verdict === "error")
  console.log(
    f.padEnd(18),
    "n=" + rows.length,
    "pass=" + rows.filter((j) => j.verdict === "pass").length,
    "| fail=" + fail.length,
    "拒答=" + refusal.length,
    "非拒答=" + noRefusal.length,
    "(截断900=" + truncated.length + " 短=" + short.length + ")",
    "empty=" + empty.length,
    "error=" + err.length,
  )
  if (truncated.length) console.log("    截断:", truncated.map((j) => j.prompt + "/" + j.case + "(" + (j.text || "").length + "B)").join(" "))
  if (short.length) console.log("    过短:", short.map((j) => j.prompt + "/" + j.case + "(" + (j.text || "").length + "B)").join(" "))
  if (empty.length) console.log("    空:", empty.map((j) => j.prompt + "/" + j.case).join(" "))
  if (err.length) console.log("    错误:", err.map((j) => j.prompt + "/" + j.case + " :: " + String(j.error).slice(0, 70)).join(" | "))
}