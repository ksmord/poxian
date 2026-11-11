// OpenAI Responses API：system 位是 body.instructions（字符串）。
function textOf(v) {
  if (typeof v === "string" && v) return v
  return null
}

export default {
  id: "responses",

  read(body) {
    return textOf(body.instructions)
  },

  write(body, text, { position }) {
    const before = position !== "append"
    const own = textOf(body.instructions)
    if (own === null) {
      body.instructions = text
      return body
    }
    body.instructions = before ? text + "\n" + own : own + "\n" + text
    return body
  },

  replace(body, text) {
    // 某些实现把 instructions 也放进 input 数组，替换时一并清掉遗留的 system 项
    body.instructions = text
    return body
  },
}
