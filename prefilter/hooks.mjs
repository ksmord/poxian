// poxian-prefilter · 独立钩子壳
//
// 用途：只想做报文清洗、不想注入提示词的场景。
// magpie.hooks 契约：export async function onRequest(body, ctx)
//   - 返回 body      → 替换请求
//   - 返回 undefined → 请求原样放行
//
// 清洗逻辑只有一份，在 ../src/filter.mjs。这里不复制实现，
// 否则两份关键词表迟早漂移（改了一处、另一处还在按旧表删）。
//
// 与主插件的关系：poxian 本体在 src/core.mjs 里调同一个 filterMessages；
// 装了本体就不要再单独装本壳，否则同一请求会被清洗两遍（幂等，但白付一次克隆）。
import { filterMessages } from "../src/filter.mjs"

function readOptions(ctx) {
  const raw = (ctx && ctx.options) || {}
  // 兼容两种写法：嵌套 magpie.options 与已拍平的顶层键。
  const nested = raw.magpie && typeof raw.magpie === "object" ? raw.magpie.options : null
  return nested && typeof nested === "object" ? nested : raw
}

export async function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return undefined

  const o = readOptions(ctx)

  // 默认关：这个壳的唯一价值就是清洗，没显式打开就什么都不做。
  if (o.enabled !== true) return undefined

  const next = filterMessages(body, {
    enabled: true,
    strip_safety_system: o.strip_safety_system !== false,
    strip_deny_assistant: o.strip_deny_assistant === true,
  })

  return next === body ? undefined : next
}

export default { onRequest }
