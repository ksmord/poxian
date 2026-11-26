// 路由适配表：回答「这条上游配哪份载荷」。
//
// ── 为什么需要独立一层 ────────────────────────────────────────────
// bench/MATRIX.md（n=384，r1–r4 合并）给出的最强结论是**路由是主变量、人格是噪声**：
//   glm5.2   53.1% (68/128)  95%CI 44.5–61.6
//   dp4.1f   43.8% (28/64)   32.3–55.9
//   hy4      32.8% (21/64)   22.6–45.0
//   glm5.3   25.0% (16/64)   16.0–36.8
//   k3.1pro  15.6% (10/64)    8.7–26.4
// glm5.2 与 k3.1pro 区间完全不重叠（差 37pp）；而八份人格两两区间**全部重叠**，
// 第一名 yesha 53.6% 与末名小猫 25.0% 的端点几乎相接（40.7 vs 40.2）。
// 所以「挑人格」不是一个统计上成立的决策；**按路由挑人格**才是。
//
// 最坑点实锤：寒霜v3 × dp4.1f = 12.5% (1/8)，同一份载荷换到 glm5.2 = 56.3% (9/16)。
// 载荷没有绝对强弱，只有路由适配。这张表就是把这句话变成可执行的数据。
//
// ── 表怎么读 ──────────────────────────────────────────────────────
// 每格是观测到的复合成功率，样本量写在后面。**只有 n ≥ 8 的格子才进表**，
// n < 8 的观测不进决策——那不是数据，是运气。
//
// ── 这层不做什么 ──────────────────────────────────────────────────
// 不改报文、不碰 fs、不碰网络。它只回答一个问题：给定 route，返回推荐的载荷 id。
// 返回 null 表示「这条路由没有足够证据」，调用方应当保持用户原配置不动——
// **没有数据就不做决策**，不是「猜一个更好的」。
//
// 依据来源：bench/MATRIX.md · 2026-11-24 · 八份载荷 × 五路由 × 四轮 384 次。

// 归一：group/glm5.2 → glm5.2。上游标识前缀不稳定，只取最后一段。
export function routeOf(model) {
  const s = typeof model === "string" ? model.trim().toLowerCase() : ""
  if (!s) return ""
  const i = s.lastIndexOf("/")
  return i === -1 ? s : s.slice(i + 1)
}

// 观测矩阵。键是归一后的路由名，值是 { 载荷id: [通过数, 样本数] }。
// 逐格抄自 bench/MATRIX.md「人格 × 路由矩阵」，不插值、不合并、不取整。
const OBSERVED = {
  "glm5.2": {
    yesha: [11, 16],
    "fujiang": [9, 16],
    v3: [9, 16],
    "fujiang-lite": [7, 16],
    dagou: [5, 8],
    guomo: [3, 8],
    pojia: [2, 8],
    xiaomao: [2, 8],
  },
  "dp4.1f": {
    "fujiang": [5, 8],
    yesha: [4, 8],
    dagou: [4, 8],
    "fujiang-lite": [4, 8],
    pojia: [4, 8],
    guomo: [3, 8],
    xiaomao: [3, 8],
    v3: [1, 8],
  },
  hy4: {
    yesha: [4, 8],
    dagou: [4, 8],
    guomo: [3, 8],
    pojia: [3, 8],
    "fujiang": [2, 8],
    v3: [2, 8],
    xiaomao: [2, 8],
    "fujiang-lite": [1, 8],
  },
  "glm5.3": {
    yesha: [3, 8],
    "fujiang-lite": [3, 8],
    pojia: [3, 8],
    guomo: [2, 8],
    xiaomao: [2, 8],
    dagou: [1, 8],
    "fujiang": [1, 8],
    v3: [1, 8],
  },
  "k3.1pro": {
    yesha: [2, 8],
    guomo: [2, 8],
    dagou: [1, 8],
    "fujiang": [1, 8],
    "fujiang-lite": [1, 8],
    pojia: [1, 8],
    v3: [1, 8],
    xiaomao: [1, 8],
  },
}

// 样本下限。低于这个数的格子不进决策——见文件头「只有 n ≥ 8 才进表」。
export const MIN_N = 8

/**
 * 给定路由，返回这条路由上观测到的最好载荷；路由完全没数据时返回 null。
 *
 * 刻意**不设「低于多少就不注入」的门槛**：那需要一个反事实基线
 * （不注入时这些硬活的通过率是多少），而 bench/ 至今没测过。
 * 没有反事实就断言「25% 不值得」，那是猜的，不是算的。
 * 因此这里只做一件事：把这条路由上的最优解找出来，收益率如实报给调用方。
 *
 * @param {string} model  body.model 或 ctx.model 原值
 * @returns {{ id: string, rate: number, pass: number, n: number, route: string } | null}
 */
export function recommend(model) {
  const route = routeOf(model)
  const row = OBSERVED[route]
  if (!row) return null

  let best = null
  for (const [id, pair] of Object.entries(row)) {
    const [pass, n] = pair
    if (n < MIN_N) continue
    const rate = pass / n
    // 同率时取样本量大的那个：样本多意味着这个估计更可信，不是同分随便挑。
    if (!best || rate > best.rate || (rate === best.rate && n > best.n)) {
      best = { id, rate, pass, n, route }
    }
  }

  return best
}

/**
 * 路由的观测产出画像，供调用方（页面 / 日志）自己判定要不要注入。
 * 返回 null 表示这条路由从未被测过——**未知不等于安全，也不等于无效**。
 */
export function yieldOf(model) {
  const r = recommend(model)
  if (!r) return null
  return {
    route: r.route,
    best: r.id,
    rate: r.rate,
    n: r.n,
    // 全路由合并 37.2%（MATRIX.md 口径）。只作参照，不作门限。
    vsOverall: r.rate - 0.372,
  }
}

// 观测表只读导出，给页面/校验脚本对账用。返回深拷贝，调用方改不坏本源。
export function observedTable() {
  const out = {}
  for (const [route, row] of Object.entries(OBSERVED)) {
    out[route] = {}
    for (const [id, [pass, n]] of Object.entries(row)) out[route][id] = { pass, n, rate: pass / n }
  }
  return out
}