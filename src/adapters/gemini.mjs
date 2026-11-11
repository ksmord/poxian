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

  replace(body, text) {
    const k = keyOf(body)
    body[k] = { parts: [{ text }] }
    return body
  },
}
