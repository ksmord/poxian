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
    // §3 写入守卫：类型 → 非空 → 写入。
    if (typeof text !== "string" || !text) return undefined
    body.instructions = text
    // Responses 协议有两个 system 位：顶层 `instructions`，以及 `input[]` 里
    // role 为 system/developer 的条目。只写 instructions 等于只堵住前门。
    //
    // 实测（2026-11-26）：instructions 已替换，input 里两条「原生对齐条款」仍原样保留，
    // 模型照样读到供应商对齐条款 —— 跳过这类残留是 replace 语义失效的直接原因。
    // 上游 qzyfl/magpie-prompt-override 的 dropInputRoles 就是干这个的。
    //
    // §4 互斥条件：input 可能是字符串（整段文本），那种情况没有 role 结构，不动；
    // 条目带 tool_calls / tool_call_id 的也不动（工具链，删了上游会 400）。
    const inp = body.input
    if (Array.isArray(inp)) {
      const keep = []
      for (const m of inp) {
        if (!m || typeof m !== "object") { keep.push(m); continue }
        const isSys = m.role === "system" || m.role === "developer"
        if (!isSys) { keep.push(m); continue }
        if (m.tool_calls || m.tool_call_id) { keep.push(m); continue }
        if (Array.isArray(m.content)) { keep.push(m); continue } // 多模态结构拿不准，不碰
        // 纯文本 system 项：替换语义要求清掉
      }
      body.input = keep
    }
    return body
  },
}