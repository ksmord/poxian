// 验证 magpie 的 model-params 中间件是否覆盖了客户端显式给的 max_tokens。
// 若 respectExplicit:false 生效，则会话里传 50 也会被改成 8192（上游再顶到 4096）。
const BASE = "http://127.0.0.1:3425/v1/chat/completions"
const KEY = process.env.POXIAN_KEY || "sk-test"

async function once(n) {
  const t0 = Date.now()
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: "group/dp4.1f",
      messages: [{ role: "user", content: "从 1 数到 200，每个数字之间用空格，不要省略。" }],
      max_tokens: n,
      stream: false,
    }),
  })
  const raw = await res.text()
  if (!res.ok) return { n, err: "HTTP " + res.status + " " + raw.slice(0, 100) }
  const d = JSON.parse(raw)
  const c = d?.choices?.[0] || {}
  return {
    n,
    finish: c.finish_reason,
    ctok: d?.usage?.completion_tokens,
    len: (c.message?.content || "").length,
    ms: Date.now() - t0,
  }
}

for (const n of [50, 700, 2000]) {
  const r = await once(n)
  console.log(
    `请求 max_tokens=${String(r.n).padEnd(5)} → finish=${String(r.finish).padEnd(8)} completion_tokens=${String(r.ctok).padEnd(6)} 正文=${String(r.len).padEnd(5)}B ${r.err || ""}`,
  )
}
console.log("")
console.log("判读：若 50 的 completion_tokens 明显 > 50，说明客户端 max_tokens 被中间件覆盖。")