// 会话级拒答锁存（内存 Map）。
//
// 为什么是内存而不是落盘：旧状态不该跨进程存活。一次误判如果写进磁盘，
// 用户下次启动还带着「这个会话上次拒过」的结论，人格会莫名其妙一直是全量注入。
// 重启即清空，代价是冷启动后第一条可能裸奔——这条代价写在 docs/options.md 里，不藏。
//
// 键的来历：客户端没有 session id（Claude Code / Codex 每轮重发整段历史），
// 只能用 agent|model|首条 user 文本 的指纹做伪会话键。历史被压缩后首条会变，
// 键随之断裂——所以 latch 只是「加速档」，不能当「唯一注入依据」。

const M = new Map()

export function hit(key, now = Date.now()) {
  if (!key) return false
  const e = M.get(key)
  if (!e) return false
  if (e.until <= now) {
    M.delete(key)
    return false
  }
  return true
}

export function arm(key, ttlMs, now = Date.now(), max = 512) {
  if (!key) return
  const prev = M.get(key)
  M.set(key, {
    until: now + (ttlMs > 0 ? ttlMs : 300000),
    strikes: (prev && prev.until > now ? prev.strikes : 0) + 1,
    at: now,
  })
  if (M.size > max) evict(max)
}

export function clear(key) {
  if (key) M.delete(key)
}

export function strikes(key, now = Date.now()) {
  const e = key ? M.get(key) : null
  if (!e || e.until <= now) return 0
  return e.strikes
}

export function sweep(now = Date.now()) {
  for (const [k, v] of M) if (v.until <= now) M.delete(k)
}

export function size() {
  return M.size
}

export function reset() {
  M.clear()
}

// 淘汰最旧；Map 迭代顺序即插入顺序。
function evict(max) {
  const over = M.size - max
  let n = 0
  for (const k of M.keys()) {
    if (n++ >= over) break
    M.delete(k)
  }
}
