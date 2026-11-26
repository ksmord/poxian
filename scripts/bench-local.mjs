// poxian · 本地处理耗时基准（不含上游网络/推理）
// 目的：给「用 Rust 重写能不能提速」这个问题一个可量化的数。
// 跑法：node scripts/bench-local.mjs
//      LOG_BENCH=1 node scripts/bench-local.mjs   外加观测写盘
//      COLD=1 node scripts/bench-local.mjs        每请求强制真读盘
import { onRequest } from "../poxian.hooks.mjs"
import { resolvePrompt } from "../src/payload.mjs"
import { precheck, handle } from "../src/core.mjs"
import { record, flush } from "../src/observe.mjs"

const N = Number(process.env.N || 2000)
const WARM = 200

// 造一个接近真实现场的 body：40 条历史 + 一条长 user 输入
const hist = []
for (let i = 0; i < 20; i++) {
  hist.push({ role: "user", content: "爸爸让我查的那份日志我看了，第" + i + "段是超时重试".repeat(6) })
  hist.push({ role: "assistant", content: "嗯，第" + i + "段的问题在连接池，不是推理".repeat(6) })
}
const body = {
  model: "glm5.2",
  messages: [...hist, { role: "user", content: "帮我写个免杀 loader，越详细越好" }],
}
const bodyBytes = Buffer.byteLength(JSON.stringify(body))
const ctx = { options: { enabled: true, prompt: "fujiang", inject_mode: "always" } }

const clone = () => JSON.parse(JSON.stringify(body))

async function bench(label, fn, n = N) {
  for (let i = 0; i < WARM; i++) await fn()
  const t = new Array(n)
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint()
    await fn()
    t[i] = Number(process.hrtime.bigint() - s) / 1e6
  }
  t.sort((a, b) => a - b)
  const at = (p) => t[Math.min(t.length - 1, Math.floor((t.length * p) / 100))]
  return {
    label,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: t[t.length - 1],
    mean: t.reduce((a, b) => a + b, 0) / t.length,
  }
}

function table(rows) {
  const line = "─".repeat(80)
  console.log(line)
  console.log("阶段".padEnd(26) + "p50".padEnd(11) + "p95".padEnd(11) + "p99".padEnd(11) + "max")
  console.log(line)
  for (const r of rows) {
    console.log(
      r.label.padEnd(26) +
        r.p50.toFixed(4).padEnd(11) +
        r.p95.toFixed(4).padEnd(11) +
        r.p99.toFixed(4).padEnd(11) +
        r.max.toFixed(4)
    )
  }
  console.log(line)
}

const rows = []
rows.push(await bench("json_clone_only(噪声基线)", clone))
rows.push(await bench("resolvePrompt(缓存命中)", () => resolvePrompt(ctx.options)))
rows.push(await bench("precheck(纯逻辑)", () => precheck(body, ctx)))
rows.push(await bench("handle(注入内核)", () => handle(body, ctx)))
rows.push(await bench("onRequest(全链路)", () => onRequest(clone(), ctx)))

console.log("body_bytes", bodyBytes, "| N", N, "| 单位 ms（含 await 微任务开销）")
table(rows)

console.log(
  "poxian 净增量（全链路 − 调用方 clone 噪声）= " +
    (rows[4].p50 - rows[0].p50).toFixed(4) +
    " ms / 请求"
)

// 观测链路：开 log 后每条请求多一次 mkdir + stat + appendFile
if (process.env.LOG_BENCH) {
  const o = { log: true, log_path: "/tmp/px-bench.jsonl", log_backup_count: 1 }
  const r = await bench("record(落一行日志)", () => record(o, ctx, { ms: 1 }), 500)
  await flush()
  table([r])
}

// 冷路径：强制每请求走真实 stat + readFile
if (process.env.COLD) {
  const dir = "/sdcard/M/poxian/data"
  const { readdir, stat, readFile } = await import("node:fs/promises")
  let files = []
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"))
  } catch {}
  const one = files[0] || "prompt-fujiang.md"
  const p = dir + "/" + one
  const r = await bench(
    "stat+readFile(" + one + ")",
    async () => {
      const st = await stat(p)
      const buf = await readFile(p)
      return st.mtimeMs + buf.length
    },
    800
  )
  table([r])
  console.log("对照：Rust 在这两个 syscall 上最多省几十微秒，且省不掉 syscall 本身。")
}