import test from "node:test"
import assert from "node:assert/strict"
import * as latch from "../src/latch.mjs"

test("latch: arm → hit → 过期后不再命中", () => {
  latch.reset()
  const t0 = 1000
  latch.arm("s_a", 300000, t0)
  assert.equal(latch.hit("s_a", t0 + 1), true)
  assert.equal(latch.hit("s_a", t0 + 299999), true)
  assert.equal(latch.hit("s_a", t0 + 300001), false)
  assert.equal(latch.size(), 0, "过期项在读取时顺手删掉")
})

test("latch: clear 立即失效", () => {
  latch.reset()
  latch.arm("s_b", 1000, 0)
  latch.clear("s_b")
  assert.equal(latch.hit("s_b", 0), false)
})

test("latch: 连续拒答累加 strikes，过期后重新计数", () => {
  latch.reset()
  latch.arm("s_c", 1000, 0)
  latch.arm("s_c", 1000, 10)
  latch.arm("s_c", 1000, 20)
  assert.equal(latch.strikes("s_c", 20), 3)
  latch.arm("s_c", 1000, 5000)
  assert.equal(latch.strikes("s_c", 5000), 1, "过期后的第一次拒答应当从 1 开始")
})

test("latch: 容量上限淘汰最旧，不无限增长", () => {
  latch.reset()
  for (let i = 0; i < 20; i++) latch.arm("k" + i, 1e9, 0, 8)
  assert.equal(latch.size(), 8)
  assert.equal(latch.hit("k0", 0), false, "最旧的被淘汰")
  assert.equal(latch.hit("k19", 0), true, "最新的还在")
})

test("latch: 空键一律不命中、不报错", () => {
  latch.reset()
  latch.arm(null, 1000, 0)
  latch.arm("", 1000, 0)
  assert.equal(latch.hit(null), false)
  assert.equal(latch.hit(""), false)
  assert.equal(latch.size(), 0)
})

test("latch: ttl<=0 回落到 300s，而不是立刻过期", () => {
  latch.reset()
  latch.arm("s_d", 0, 0)
  assert.equal(latch.hit("s_d", 299999), true)
  assert.equal(latch.hit("s_d", 300001), false)
})
