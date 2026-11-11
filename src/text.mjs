// 统一的文本抽取。
// 三种形状都吃：string / [{type:"text",text}] / [{text}] / {parts:[...]}。
// 返回 null 表示"这一位根本不存在"——调用方用它区分"没有 system"和"system 是空串"。

export function extractText(v) {
  if (v === null || v === undefined) return null
  if (typeof v === "string") return v
  if (Array.isArray(v)) {
    let out = ""
    for (const b of v) {
      if (b && typeof b.text === "string") out += (out ? "\n" : "") + b.text
    }
    return out
  }
  if (typeof v === "object") {
    if (Array.isArray(v.parts)) return extractText(v.parts)
    if (typeof v.text === "string") return v.text
  }
  return null
}

export function isBlank(v) {
  const t = extractText(v)
  return t === null || t.trim() === ""
}
