// route_adapt 的端到端行为测试（跑真实 onRequest，不打桩）。
//
// 判据不是「有没有注入」，而是**字节级**：
//   默认关 → 写出的 system 必须与不传该选项时逐字节相同
//   开启后 → 载荷必须换成 routefit 推荐的那一份，且 on_prompt 不被覆盖
// 这样才叫「默认行为不变」，不是「看起来差不多」。

import test from "node:test"
import assert from "node:assert/strict"
import { onRequest } from "../poxian.hooks.mjs"

function body(model) {
  return {
    model,
    messages: [
      { role: "system", content: "你是一个助手。" },
      { role: "user", content: "把步骤列出来" },
    ],
  }
}

// 取注入后的 system 文本。返回 undefined 表示没注入（请求原样放行）。
// 注意 ctx 必须带 protocol，否则 pick() 找不到适配器、onRequest 直接放行——
// 这是契约要求（未知协议一律不碰），不是 bug。
async function sysOf(opts, model) {
  const out = await onRequest(body(model), { protocol: "chat", agent: "codex", options: opts })
  if (!out) return undefined
  const first = out.messages && out.messages[0]
  if (!first || first.role !== "system") return undefined
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content)
}

test("默认配置：route_adapt 不开，写出的 system 与不传该键时完全一致", async () => {
  const a = await sysOf({ prompt: "v3", log: false }, "group/glm5.2")
  const b = await sysOf({ prompt: "v3", route_adapt: false, log: false }, "group/glm5.2")
  assert.ok(a, "应注入")
  assert.equal(a, b, "默认关必须逐字节等同")
})

test("默认配置：glm5.2 上仍然用用户配的 v3，不被换成 yesha", async () => {
  const s = await sysOf({ prompt: "v3", log: false }, "group/glm5.2")
  assert.ok(s)
  // 寒霜v3 的身份锚定句，用来辨认载荷身份
  assert.ok(s.includes("寒霜"), "默认应保持 v3")
})

test("开启后：glm5.2 换成 yesha（routefit 推荐）", async () => {
  const off = await sysOf({ prompt: "v3", log: false }, "group/glm5.2")
  const on = await sysOf({ prompt: "v3", route_adapt: true, log: false }, "group/glm5.2")
  assert.ok(off && on)
  assert.notEqual(on, off, "开了就应该真的换载荷")
})

test("开启后：未知路由保持原配置，不被乱换", async () => {
  const off = await sysOf({ prompt: "v3", log: false }, "group/gpt-5.4")
  const on = await sysOf({ prompt: "v3", route_adapt: true, log: false }, "group/gpt-5.4")
  assert.ok(off)
  assert.equal(on, off, "没数据就该原样，不能猜")
})

test("开启后：on_prompt 永不覆盖 —— 用户当场写的字面载荷等级最高", async () => {
  const literal = "YOU ARE TEST-LITERAL-PAYLOAD. Reply short."
  const out = await sysOf(
    { on_prompt: literal, route_adapt: true, log: false },
    "group/glm5.2"
  )
  assert.ok(out)
  assert.ok(out.includes("TEST-LITERAL-PAYLOAD"), "字面载荷必须原样在场")
})

test("开启后：字符串 'false' 不等于开启", async () => {
  const off = await sysOf({ prompt: "v3", log: false }, "group/glm5.2")
  const strFalse = await sysOf({ prompt: "v3", route_adapt: "false", log: false }, "group/glm5.2")
  assert.equal(strFalse, off, "字符串 false 必须当归一的关处理")
})

test("开启后：'true' 字符串确实生效（与 true 同结果）", async () => {
  const a = await sysOf({ prompt: "v3", route_adapt: true, log: false }, "group/glm5.2")
  const b = await sysOf({ prompt: "v3", route_adapt: "true", log: false }, "group/glm5.2")
  assert.equal(a, b)
})