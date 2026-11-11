// Anthropic Messages API：system 位是 body.system，string 或 block 数组。
import { CACHE, CACHE_LIMIT } from "../constants.mjs"

function textOf(s) {
  if (typeof s === "string") return s
  if (Array.isArray(s)) {
    let out = ""
    for (const b of s) {
      if (b && typeof b.text === "string") out += (out ? "\n" : "") + b.text
    }
    return out
  }
  return null
}

// 4 个 cache_control 是硬上限，超了 API 直接 400。
function hasCacheRoom(body) {
  let n = 0
  const bump = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (b && b.cache_control) n++
    }
  }
  bump(body.system)
  if (Array.isArray(body.messages)) for (const m of body.messages) if (m) bump(m.content)
  return n < CACHE_LIMIT
}

export default {
  id: "anthropic",

  read(body) {
    return textOf(body.system)
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

  replace(body, text) {
    body.system = text
    return body
  },
}
