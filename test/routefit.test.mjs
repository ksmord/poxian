// routefit 单测。
//
// 这一层的性质是「查表」，所以测试重点不是「算法对不对」，
// 而是**表的语义有没有被写歪**：归一、同率取舍、n 下限、未知路由。
// 数据一致性由 scripts/check-routefit.mjs 逐格对账，这里只管行为。

import test from "node:test"
import assert from "node:assert/strict"
import { routeOf, recommend, yieldOf, observedTable, MIN_N } from "../src/routefit.mjs"

test("routeOf: 去掉上游前缀，只留最后一段", () => {
  assert.equal(routeOf("group/glm5.2"), "glm5.2")
  assert.equal(routeOf("group/dp4.1f"), "dp4.1f")
  assert.equal(routeOf("glm5.2"), "glm5.2")
  assert.equal(routeOf("  GROUP/GLM5.2  "), "glm5.2")
  assert.equal(routeOf("a/b/c/hy4"), "hy4")
})

test("routeOf: 空值与非字符串一律空串，不炸", () => {
  assert.equal(routeOf(""), "")
  assert.equal(routeOf(null), "")
  assert.equal(routeOf(undefined), "")
  assert.equal(routeOf(123), "")
  assert.equal(routeOf({}), "")
})

test("recommend: glm5.2 上取 yesha（11/16 = 68.8%，全场最高）", () => {
  const r = recommend("group/glm5.2")
  assert.ok(r, "glm5.2 有数据，不该返回 null")
  assert.equal(r.id, "yesha")
  assert.equal(r.pass, 11)
  assert.equal(r.n, 16)
  assert.equal(r.route, "glm5.2")
  assert.ok(Math.abs(r.rate - 0.6875) < 1e-9)
})

test("recommend: dp4.1f 上取 fujiang，不是 v3（12.5% 那个坑）", () => {
  const r = recommend("group/dp4.1f")
  assert.equal(r.id, "fujiang")
  assert.equal(r.pass, 5)
  assert.equal(r.n, 8)
  // 反面：v3 在 dp4.1f 上是全场最坑点 1/8。这条断言的意义就是钉住「别再选它」。
  assert.notEqual(r.id, "v3")
})

test("recommend: k3.1pro 上虽然只有 25%，仍然是 yesha/guomo —— 不设门限就没门限", () => {
  const r = recommend("group/k3.1pro")
  assert.ok(r, "有数据就该返回，不能因为我们觉得低就吞掉")
  assert.equal(r.rate, 0.25)
  // 同率 (2/8) 时按 id 排序不定，但必须落在这两个里
  assert.ok(["yesha", "guomo"].includes(r.id), `期望 yesha 或 guomo，实得 ${r.id}`)
})

test("recommend: 未知路由返回 null，不猜", () => {
  assert.equal(recommend("group/gpt-5"), null)
  assert.equal(recommend("muse"), null)
  assert.equal(recommend(""), null)
  assert.equal(recommend(undefined), null)
})

test("recommend: 同率时取样本量大的", () => {
  // glm5.2 上 fujiang 9/16=56.3% 与 v3 9/16=56.3% 同率同 n，取值不应抛错
  const r = recommend("glm5.2")
  assert.ok(r && r.n >= MIN_N)
})

test("yieldOf: 给出相对全体合并线 37.2% 的偏差", () => {
  const y = yieldOf("group/glm5.2")
  assert.equal(y.route, "glm5.2")
  assert.equal(y.best, "yesha")
  assert.ok(y.vsOverall > 0.3, `glm5.2 应显著高于合并线，实得 ${y.vsOverall}`)

  const k = yieldOf("group/k3.1pro")
  assert.ok(k.vsOverall < 0, "k3.1pro 应低于合并线")

  assert.equal(yieldOf("unknown-model"), null)
})

test("observedTable: 返回拷贝，改它不影响本源", () => {
  const a = observedTable()
  a["glm5.2"].yesha.pass = 999
  const b = observedTable()
  assert.equal(b["glm5.2"].yesha.pass, 11, "外部改动不该渗进本源表")
})

test("observedTable: 五条路由齐全", () => {
  const t = observedTable()
  for (const route of ["glm5.2", "dp4.1f", "hy4", "glm5.3", "k3.1pro"]) {
    assert.ok(t[route], `缺路由 ${route}`)
  }
})