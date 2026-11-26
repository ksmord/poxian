// OpenAI 兼容 chat：system 位是首条 role=system/developer 的 message。
import { extractText } from "../text.mjs"

function systemIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m && (m.role === "system" || m.role === "developer")) return i
  }
  return -1
}

export default {
  id: "chat",

  read(body) {
    const i = systemIndex(body.messages)
    return i === -1 ? null : extractText(body.messages[i].content)
  },

  write(body, text, { position }) {
    const before = position !== "append"
    if (!Array.isArray(body.messages)) return undefined

    const i = systemIndex(body.messages)
    if (i === -1) {
      body.messages.unshift({ role: "system", content: text })
      return body
    }

    const m = body.messages[i]
    if (typeof m.content === "string") {
      m.content = before ? text + "\n" + m.content : m.content + "\n" + text
      return body
    }
    if (Array.isArray(m.content)) {
      const block = { type: "text", text }
      if (before) m.content.unshift(block)
      else m.content.push(block)
      return body
    }
    m.content = text
    return body
  },

  // 探针回显的落点：最后一条 user 消息的尾部，不是 system。
  // system 是缓存前缀的头，往那里塞每请求都变的 nonce，上游前缀缓存在 nonce 处断链，
  // 后面整段历史每轮都得重新 prefill（实测 79.4% → 1.3%，cache_read 恒等于 1024）。
  tail(body, text) {
    if (!Array.isArray(body.messages)) return undefined
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i]
      if (!m || m.role !== "user") continue
      if (typeof m.content === "string") m.content = m.content + "\n" + text
      else if (Array.isArray(m.content)) m.content.push({ type: "text", text })
      else m.content = text
      return body
    }
    body.messages.push({ role: "user", content: text })
    return body
  },

  replace(body, text) {
    // §3 写入守卫：类型 → 非空 → 前置条件 → 写入。顺序不能反。
    if (typeof text !== "string" || !text) return undefined
    if (!Array.isArray(body.messages)) return undefined
    const isSys = (m) => m && (m.role === "system" || m.role === "developer")
    const i = systemIndex(body.messages)
    if (i === -1) body.messages.unshift({ role: "system", content: text })
    else body.messages[i].content = text
    // 清掉**其余**的 system/developer。
    //
    // 为什么必须清：replace 语义是「只留我的这套」。旧版只换第一条，把后面的原样留着，
    // 实测（2026-11-26）三条 system 的请求替换后还剩 2 条「原生对齐条款 B/C」——
    // 模型照样读到供应商的对齐条款，注入被顶掉一半，表现为「拒答特别多」。
    // 上游 qzyfl/magpie-prompt-override 的 dropInputRoles 干的就是这件事。
    //
    // §4 互斥条件：只删「完全没有 tool 结构」的纯文本项。带 tool_calls / tool_call_id
    // 的消息不动——那属于工具链，删了会让上游 400。拿不准就不动，比删错安全。
    //
    // 写法说明：先收集下标再从大到小删除，**不要**在循环里改 `i`。
    // moejs 的静态检查会直接拒绝「给 const 赋值」（BuildMessage: assignment will throw
    // because "i" is a constant）——Node 放行但插件宿主不放行，这是实机装包时踩到的。
    const drop = []
    for (let k = 0; k < body.messages.length; k++) {
      const m = body.messages[k]
      if (!isSys(m) || k === i) continue
      if (m.tool_calls || m.tool_call_id || m.role === "tool") continue
      if (Array.isArray(m.content)) continue // 多模态块拿不准结构，不碰
      drop.push(k)
    }
    for (let n = drop.length - 1; n >= 0; n--) body.messages.splice(drop[n], 1)
    return body
  },
}