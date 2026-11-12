// 自动判断：不写白名单时，按「先验 + 该路由滑动统计」决定开不开预填。
//
// 断言的契约：
//   1. 显式白名单永远优先，写死了就不再让统计插手；
//   2. 先验来自 bench 实测（hy4 正、dp4.1f / k3 负、glm 微负）；
//   3. 未登记路由证据不足时默认关，不猜；
//   4. 拒答持续出现会把已开的路由翻成关，且 n≥4 才动手。
import test from "node:test"
import assert from "node:assert/strict"

import {
  decidePrefill,
  notePrefillResult,
  prefillStats,
  resetPrefillStats,
} from "../src/prefill.mjs"

const O = (extra) => ({ prefill: "```", prefill_models: [], prefill_auto: true, ...extra })

test.beforeEach(() => resetPrefillStats())

test("先验：hy4 开，dp4.1f / k3 / k3.1pro 关", () => {
  assert.equal(decidePrefill(O(), "group/hy4").on, true)
  assert.equal(decidePrefill(O(), "group/hy4-mini").on, true)
  assert.equal(decidePrefill(O(), "group/dp4.1f").on, false)
  assert.equal(decidePrefill(O(), "group/k3.1pro").on, false)
  assert.equal(decidePrefill(O(), "group/k3").on, false)
  assert.equal(decidePrefill(O(), "group/glm5.3").on, false, "glm 先验 -0.5，不到 0.5 门槛")
})

test("未登记路由：证据不足时关，不猜", () => {
  const d = decidePrefill(O(), "group/unknown")
  assert.equal(d.on, false)
  assert.match(d.why, /证据不足/)
})

test("显式白名单优先于先验：写死了就不让统计插手", () => {
  const o = O({ prefill_models: ["group/dp4.1f"] })
  assert.equal(decidePrefill(o, "group/dp4.1f").on, true)
  assert.equal(decidePrefill(o, "group/hy4").on, false)
})

test("prefill_auto 关闭时只认白名单", () => {
  const o = O({ prefill_auto: false })
  assert.equal(decidePrefill(o, "group/hy4").on, false)
})

test("统计能把 hy4 翻成关：连续拒答 4 次后关掉", () => {
  assert.equal(decidePrefill(O(), "group/hy4").on, true)
  for (let i = 0; i < 4; i++) notePrefillResult("group/hy4", { ok: false, refused: true })
  const s = prefillStats("group/hy4")
  assert.equal(s.n, 4)
  assert.equal(decidePrefill(O(), "group/hy4").on, false)
})

test("统计能把未登记路由翻成开：连续交付 4 次后开", () => {
  assert.equal(decidePrefill(O(), "group/unknown").on, false)
  for (let i = 0; i < 4; i++) notePrefillResult("group/unknown", { ok: true, refused: false })
  assert.equal(decidePrefill(O(), "group/unknown").on, true)
})

test("先验为负的路由，统计要更多证据才翻正", () => {
  for (let i = 0; i < 4; i++) notePrefillResult("group/dp4.1f", { ok: true, refused: false })
  // -2 + 1.5*1 = -0.5，仍不过门槛
  assert.equal(decidePrefill(O(), "group/dp4.1f").on, false)
})

test("prefill 未配置时一律关，不看统计", () => {
  notePrefillResult("group/hy4", { ok: true, refused: false })
  assert.equal(decidePrefill({ prefill: "", prefill_models: [], prefill_auto: true }, "group/hy4").on, false)
})
