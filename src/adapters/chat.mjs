// OpenAI 兼容 chat：system 位是首条 role=system/developer 的 message。
function systemIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m && (m.role === "system" || m.role === "developer")) return i
  }
  return -1
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    let out = ""
    for (const p of content) {
      if (p && typeof p === "object" && typeof p.text === "string") out += (out ? "\n" : "") + p.text
    }
    return out
  }
  return null
}

export default {
  id: "chat",

  read(body) {
    const i = systemIndex(body.messages)
    return i === -1 ? null : textOf(body.messages[i].content)
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

  replace(body, text) {
    if (!Array.isArray(body.messages)) return undefined
    const i = systemIndex(body.messages)
    if (i === -1) body.messages.unshift({ role: "system", content: text })
    else body.messages[i].content = text
    return body
  },
}
