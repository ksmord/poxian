// 副本内集成验证：实发一次网关请求，检查运行态是否真计数
// 用法：node scripts/verify-runtime.mjs [label]
import { onRequest, status } from "../poxian.hooks.mjs"
import { reset } from "../src/status.mjs"

const label = process.argv[2] || "run"
reset()

const body = { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] }
const ctx = {
  protocol: "anthropic",
  agent: "integration-test",
  model: "claude-sonnet-4",
  options: { enabled: true, log: false, probe_echo: false, handshake: false, skip_stream: false },
}

const out = await onRequest(body, ctx)
const s = status()

console.log(JSON.stringify({
  label,
  returnedBody: !!out,
  armed: s.armed,
  attempted: s.attempted,
  injected: s.injected,
  skipped: s.skipped,
  lastAction: s.lastAction,
  lastError: s.lastError,
  proto: s.proto,
}, null, 2))

if (label === "normal") {
  if (!s.armed) throw new Error("armed 未置位")
  if (s.attempted !== 1) throw new Error("attempted 应为 1，实际 " + s.attempted)
  if (s.injected !== 1) throw new Error("injected 应为 1，实际 " + s.injected)
  if (s.lastError !== null) throw new Error("正常路径不该有 lastError")
  if (s.proto !== 3) throw new Error("proto 应为 3")
  if (!out) throw new Error("正常路径应返回改写后的 body")
  console.log("NORMAL_OK")
}

if (label === "fault") {
  if (String(s.lastError || "").indexOf("INJECTED FAULT") === -1) {
    throw new Error("故障原文没进 lastError，实际：" + s.lastError)
  }
  if (out !== undefined) throw new Error("故障路径必须放行原请求（返回 undefined）")
  if (s.attempted !== 1) throw new Error("故障也应计入 attempted")
  if (s.injected !== 0) throw new Error("故障不该计入 injected")
  console.log("FAULT_OK")
}
