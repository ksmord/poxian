// OpenAI Responses API：system 位是 body.instructions（字符串）。

function own(body) {
  const t = body.instructions
  return typeof t === "string" && t ? t : null
}

export default {
  id: "responses",

  read(body) {
    return own(body)
  },

  write(body, text, { position }) {
    const existing = own(body)
    if (existing === null) {
      body.instructions = text
      return body
    }
    body.instructions = position === "append" ? existing + "\n" + text : text + "\n" + existing
    return body
  },

  // 探针回显落点：input 里最后一条 user 的尾部。instructions 是缓存前缀的头，
  // 往里塞每请求变化的 nonce 会让上游整段重新 prefill。
  tail(body, text) {
    const inp = body.input
    if (typeof inp === "string") {
      body.input = inp + "\n" + text
      return body
    }
    if (Array.isArray(inp)) {
      for (let i = inp.length - 1; i >= 0; i--) {
        const m = inp[i]
        if (!m || m.role !== "user") continue
        if (typeof m.content === "string") m.content = m.content + "\n" + text
        else if (Array.isArray(m.content)) m.content.push({ type: "input_text", text })
        else m.content = [{ type: "input_text", text }]
        return body
      }
      inp.push({ role: "user", content: [{ type: "input_text", text }] })
      return body
    }
    body.input = [{ role: "user", content: [{ type: "input_text", text }] }]
    return body
  },

  replace(body, text) {
    body.instructions = text
    return body
  },
}
