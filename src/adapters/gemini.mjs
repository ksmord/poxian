// Gemini：system 位是 systemInstruction 或 system_instruction，形状是 {parts:[{text}]} 或 string。
import { extractText } from "../text.mjs"

// 保留请求已有的字段名，不擅自改写 camel/snake。

function keyOf(body) {
  if (body.system_instruction !== undefined && body.systemInstruction === undefined) {
    return "system_instruction"
  }
  if (body.systemInstruction !== undefined) return "systemInstruction"
  if (body.system_instruction !== undefined) return "system_instruction"
  return "systemInstruction"
}

// 统一按 {parts:[...]} 写回：Gemini 的 system 位是这个形状最稳。
function asParts(v, text, before) {
  const block = { text }
  if (typeof v === "string") {
    const own = v ? [{ text: v }] : []
    return { parts: before ? [block, ...own] : [...own, block] }
  }
  if (v && typeof v === "object" && Array.isArray(v.parts)) {
    const parts = v.parts.slice()
    if (before) parts.unshift(block)
    else parts.push(block)
    return { ...v, parts }
  }
  return { parts: [block] }
}

export default {
  id: "gemini",

  read(body) {
    return extractText(body[keyOf(body)])
  },

  write(body, text, { position }) {
    const before = position !== "append"
    const k = keyOf(body)
    body[k] = asParts(body[k], text, before)
    return body
  },

  // 探针回显落点：contents 里最后一条 user 的尾部。
  // systemInstruction 是缓存前缀的头，nonce 放那里等于每轮重建整条前缀。
  tail(body, text) {
    if (!Array.isArray(body.contents)) body.contents = []
    const cs = body.contents
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i]
      if (!c || c.role !== "user") continue
      if (Array.isArray(c.parts)) c.parts.push({ text })
      else c.parts = [{ text }]
      return body
    }
    cs.push({ role: "user", parts: [{ text }] })
    return body
  },

  replace(body, text) {
    const k = keyOf(body)
    body[k] = { parts: [{ text }] }
    return body
  },
}
