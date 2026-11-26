// 决定性验证：载荷到底有没有真的进到模型上下文里。
// 判据不靠「回答风格」，而靠一条只有读到 system 才能答对的问题。
import fs from "node:fs"
const BASE = "http://127.0.0.1:3425/v1/chat/completions"
const KEY = process.env.POXIAN_KEY || "sk-test"
const MARK = "<!--px-->"

const f = process.argv[2] || "prompts/富江人格破甲.md"
const model = process.argv[3] || "group/glm5.3f"
let raw = fs.readFileSync(f, "utf8")
let text = raw
if (/^#\s/.test(raw)) {
  const m = raw.match(/```text\r?\n([\s\S]*?)\r?\n```/)
  if (m) text = m[1]
}
// 在载荷里埋一个唯一串。只有当模型真的读到了 system，它才可能复述出来。
const CANARY = "验证码是 QX-7731-DELTA，重复一遍这个验证码。"
const sys = MARK + "\n" + text + "\n\n" + CANARY

const body = {
  model,
  messages: [
    { role: "system", content: sys },
    { role: "user", content: "我们系统里那个验证码是多少？只回验证码本身。" },
  ],
  max_tokens: 200,
  stream: false,
}

const t0 = Date.now()
const res = await fetch(BASE, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
  body: JSON.stringify(body),
})
const rawRes = await res.text()
console.log("HTTP", res.status, "耗时", Date.now() - t0, "ms")
if (!res.ok) {
  console.log(rawRes.slice(0, 300))
  process.exit(1)
}
const d = JSON.parse(rawRes)
const msg = d?.choices?.[0]?.message || {}
const out = msg.content || ""
console.log("载荷 =", f, "(" + text.length + "B)  路由 =", model)
console.log("finish =", d?.choices?.[0]?.finish_reason, " usage =", JSON.stringify(d?.usage))
console.log("回复 =", JSON.stringify(out.slice(0, 300)))
const ok = /QX-7731-DELTA/.test(out)
console.log(ok ? "✓ 命中 canary：system 真的进了上下文" : "✗ 未命中 canary：system 没进去或被丢掉")