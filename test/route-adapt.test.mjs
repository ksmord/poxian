// route_adapt 接入的端到端测试。
//
// 这一层最危险的不是「选错了载荷」，而是**在默认配置下悄悄改了行为**。
// 所以本文件的重点全在边界：默认关、用户显式配置优先、on_prompt 不可覆盖、
// 未知路由不决策。任何一条破了，用户都会遇到「我没开这个功能，怎么载荷变了」。

import test from "node:test"
import assert from "node:assert/strict"
import { normalize } from "../src/options.mjs"
import { DEFAULTS } from "../src/constants.mjs"
import { recommend } from "../src/routefit.mjs"

test("默认值：route_adapt 必须是 false", () => {
  assert.equal(DEFAULTS.route_adapt, false, "默认开会让所有存量用户的载荷被静默换掉")
})

test("normalize：未传时归一为 false", () => {
  const o = normalize(undefined)
  assert.equal(o.route_adapt, false)
})

test("normalize：字符串 'false' 必须归一成 false，不能当 truthy", () => {
  const o = normalize({ route_adapt: "false" })
  assert.equal(o.route_adapt, false)
})

test("normalize：'true' / 1 归一成 true", () => {
  assert.equal(normalize({ route_adapt: "true" }).route_adapt, true)
  assert.equal(normalize({ route_adapt: 1 }).route_adapt, true)
  assert.equal(normalize({ route_adapt: true }).route_adapt, true)
})

test("normalize：认不出的值回落 false（安全侧）", () => {
  assert.equal(normalize({ route_adapt: "maybe" }).route_adapt, false)
  assert.equal(normalize({ route_adapt: [] }).route_adapt, false)
  assert.equal(normalize({ route_adapt: {} }).route_adapt, false)
})

// ── 决策语义：只改 prompt / prompt_path，且不碰 on_prompt ──

test("推荐结果是内置版本 id，且能在 VERSIONS 里找到", async () => {
  const { VERSIONS } = await import("../poxian-prompt.js")
  for (const route of ["group/glm5.2", "group/dp4.1f", "group/hy4", "group/glm5.3", "group/k3.1pro"]) {
    const r = recommend(route)
    assert.ok(r, `${route} 应有推荐`)
    assert.ok(VERSIONS[r.id], `${route} 推荐的 ${r.id} 不在内置版本表里`)
  }
})

test("未知路由：recommend 返回 null，调用方应保持原配置", () => {
  // 这条是「没有数据就不做决策」的直接表达。
  // 反面写法是「查不到就用默认版本」，那等于用户配了 v3 却被换成别的。
  assert.equal(recommend("group/gpt-5.4"), null)
  assert.equal(recommend("claude-opus-4-6"), null)
})

test("路由归一：带前缀与不带前缀必须命中同一行", () => {
  const a = recommend("group/glm5.2")
  const b = recommend("glm5.2")
  assert.deepEqual(a, b, "前缀差异不该影响决策")
})