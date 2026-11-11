// Anthropic Messages API：system 位是 body.system，string 或 block 数组。
import { CACHE, CACHE_LIMIT } from "../constants.mjs"
import { extractText } from "../text.mjs"

// 4 个 cache_control 是硬上限，超了 API 直接 400。
// skipSystem：整段替换时旧 body.system 会被丢弃，不该再占用额度。
function hasCacheRoom(body, skipSystem) {
  let n = 0
  const bump = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (b && b.cache_control) n++
    }
  }
  if (!skipSystem) bump(body.system)
  if (Array.isArray(body.messages)) for (const m of body.messages) if (m) bump(m.content)
  return n < CACHE_LIMIT
}

export default {
  id: "anthropic",

  read(body) {
    return extractText(body.system)
  },

  write(body, text, { position, cache }) {
    const before = position !== "append"
    const block = { type: "text", text }
    if (cache && hasCacheRoom(body)) block.cache_control = CACHE

    if (body.system === undefined || body.system === null || body.system === "") {
      body.system = cache && block.cache_control ? [block] : text
      return body
    }

    if (typeof body.system === "string") {
      if (cache && block.cache_control) {
        const own = { type: "text", text: body.system }
        body.system = before ? [block, own] : [own, block]
      } else {
        body.system = before ? text + "\n" + body.system : body.system + "\n" + text
      }
      return body
    }

    if (Array.isArray(body.system)) {
      if (before) body.system.unshift(block)
      else body.system.push(block)
      return body
    }

    return undefined
  },

  // 整段替换。cache 打开时仍要挂断点并返回 block 数组——否则默认模式
  // （override_mode=replace）下 cache 会静默失效，表现为「开了缓存不生效」。
  // skipSystem=true：旧的 body.system 即将被丢弃，不参与额度计算。
  replace(body, text, { cache } = {}) {
    const block = { type: "text", text }
    if (cache && hasCacheRoom(body, true)) block.cache_control = CACHE
    body.system = block.cache_control ? [block] : text
    return body
  },
}
