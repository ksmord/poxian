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

  replace(body, text) {
    body.instructions = text
    return body
  },
}
