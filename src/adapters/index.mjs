// 协议适配器注册表。新增协议 = 加一个文件 + 在这里登记，核心不动。
import anthropic from "./anthropic.mjs"
import chat from "./chat.mjs"
import responses from "./responses.mjs"
import gemini from "./gemini.mjs"

const ADAPTERS = [anthropic, chat, responses, gemini]

const ALIASES = {
  "chat.completions": "chat",
  "messages": "anthropic",
  "openai": "chat",
  "openai-chat": "chat",
  "google": "gemini",
  "generativelanguage": "gemini",
}

const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]))

export function pick(protocol) {
  if (!protocol) return null
  const p = String(protocol).toLowerCase().trim()
  return BY_ID.get(p) || BY_ID.get(ALIASES[p]) || null
}

export function ids() {
  return ADAPTERS.map((a) => a.id)
}

export default ADAPTERS
