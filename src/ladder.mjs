// 补救阶梯：拒答之后做什么，按「代价从低到高」排队，且**只有第一次算注入**。
//
// ── 为什么需要独立一层 ────────────────────────────────────────────
// magpie 的 onResponse 是只读的（返回值被丢弃，见 src/probe.mjs 顶部实测记录），
// 所以「检测到拒答就自动换一份重发」这件事在网关层做不到——那是客户端的事。
// 能做的只有两件：
//   1. 把结论记账（哪条路由、哪种载荷、第几级补救、有没有救回来），
//   2. 给**下一次**请求准备更好的起点（升档、换落点、清掉历史里的拒绝）。
// 这一层的职责就是第 2 件的决策表，以及「不重复扣注入名额」的记账口径。
//
// ── 名额口径 ──────────────────────────────────────────────────────
// 一次请求被重发 N 次，注入发生时只能记 1 次。否则日志里的 injected 会被重试撑大，
// 真正要看的「有多少独立请求拿到了人格」反而被淹掉。
// 所以：attempt 在进入链路时 +1，重试走 retry 计数，不进 injected。
//
// ── 阶梯顺序的依据 ────────────────────────────────────────────────
// 按「改动报文的最小程度」排序，先试最轻的：
//   L0 不动报文        —— 只记账，等下一轮
//   L1 清历史里的拒绝  —— 已实现的 filter（strip_deny_assistant），只删 assistant
//   L2 升档到全量      —— 骨架 → 全量，只改 system 大小
//   L3 换落点          —— prefill / echo 位置调整，改 messages 尾部
//   L4 换载荷          —— 最后手段，整段换人格
// 前两级永远安全；L3 在 dp4.1f 上是负收益（71%→38%），所以必须先查路由先验。

import { prefillStats } from "./prefill.mjs"

// 路由先验：来自 bench/REPORT.md 的实测，不是猜的。
// 负数 = 这条路由上「加料」是负收益，补救阶梯要跳过对应级。
const PRIOR = [
  { re: /^group\/hy4\b/, prefill: 1, note: "hy4: 预填 71%→93%（13/14）" },
  { re: /^group\/dp4\.1f\b/, prefill: -1, note: "dp4.1f: 预填 71%→38%，负收益" },
  { re: /^group\/k3/i, prefill: -1, note: "k3: 两份载荷 0%，加料也到不了" },
  { re: /^group\/glm/i, prefill: 0, note: "glm*: 36%，预填无增益" },
]

function priorOf(model) {
  const m = String(model || "")
  for (const p of PRIOR) if (p.re.test(m)) return p
  return { prefill: 0, note: "未登记路由，按证据走" }
}

/**
 * 决定下一轮该上哪一级补救。
 *
 * @param {object} p
 * @param {string} p.model      当前路由
 * @param {number} p.strikes    该会话连续拒答次数（来自 latch）
 * @param {boolean} p.hasDeny   历史里是否已经出现拒绝（filter 能删）
 * @param {string} p.tier       当前档位（full / skeleton）
 * @returns {{level:number, name:string, actions:string[], why:string}}
 */
export function nextRung({ model, strikes, hasDeny, tier } = {}) {
  const n = Number(strikes) || 0
  const pr = priorOf(model)
  const st = prefillStats(model)
  // 该路由的实测成功率（EWMA）。w 是衰减权重和，除回去才是率。
  const rate = st.w > 0 ? (st.ok - st.ref) / st.w : null

  if (n <= 0) {
    return { level: 0, name: "L0-不动", actions: [], why: "没有拒答证据，保持现状" }
  }

  // 第一级：先清历史。这是唯一「只删不加」的动作，代价最低、副作用最小。
  if (hasDeny) {
    return {
      level: 1,
      name: "L1-清历史拒绝",
      actions: ["strip_deny_assistant"],
      why: "历史里有拒绝话术，模型会照着自己上一句再拒一遍；先删再谈其他",
    }
  }

  // 第二级：升档。骨架是按 token 省出来的，连续拒答说明省错了地方。
  if (tier && tier !== "full") {
    return {
      level: 2,
      name: "L2-升全量",
      actions: ["force_full"],
      why: "当前是骨架档，连续拒答说明短载荷没有取得控制权",
    }
  }

  // 第三级：换落点。只在先验非负、或本地统计已经证明有增益时才做。
  const gain = pr.prefill > 0 || (rate !== null && rate > 0.2 && st.n >= 4)
  if (gain) {
    return {
      level: 3,
      name: "L3-换落点",
      actions: ["prefill", "deny_first"],
      why: pr.note,
    }
  }

  // 第四级：换载荷。整段换人格是最后手段，写进日志时标记为 last_resort。
  return {
    level: 4,
    name: "L4-换载荷",
    actions: ["swap_payload"],
    why: `前三级无效（${pr.note}）；换载荷是最后手段`,
    last_resort: true,
  }
}

/**
 * 记账口径：一次请求 = 一次 attempt；重试不重复计入 injected。
 * 返回要合并进日志的那几个字段。
 */
export function retryLedger({ attempts, recovered, signals } = {}) {
  const a = Math.max(0, Number(attempts) || 0)
  return {
    // 与同类项目的字段名对齐，方便跨工具对账：mode / signals / retrySignals / attempts / recovered
    mode: a > 0 ? "refusal-retry" : "none",
    attempts: a,
    recovered: recovered === true,
    ...(Array.isArray(signals) && signals.length ? { signals } : {}),
  }
}