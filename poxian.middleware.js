// 兼容壳 · 已弃用
//
// 同步中间件引擎（magpie.middleware）没有 node:fs，只能吃内置 payload。
// 需要外部 .md + 热加载的，用 poxian.hooks.mjs（magpie.hooks）。
// 本文件保证老配置继续能跑，行为与新入口一致。

import { PROMPT, VERSIONS, DEFAULT_VERSION } from "./poxian-prompt.js"
import { MARK, HANDSHAKE_TEXT } from "./src/constants.mjs"
import { normalize } from "./src/options.mjs"
import { handle } from "./src/core.mjs"

const MARKED = Object.create(null)
for (const id of Object.keys(VERSIONS)) MARKED[id] = MARK + "\n" + VERSIONS[id].text
MARKED[DEFAULT_VERSION] = MARK + "\n" + PROMPT

export function onRequest(body, ctx) {
  const c = ctx || {}
  const raw = c.options || {}
  const o = normalize(raw)
  if (!o.enabled) return

  // 旧版语义：未显式给 cache 时默认开。保持 cases.json 的快照仍成立，
  // 新入口（poxian.hooks.mjs）走 package.json 的默认值 false。
  if (!Object.prototype.hasOwnProperty.call(raw, "cache")) o.cache = true

  const text = o.on_prompt
    ? MARK + "\n" + o.on_prompt
    : MARKED[o.prompt] || MARKED[DEFAULT_VERSION]

  return handle(body, c, { text, handshake: MARK + "\n" + HANDSHAKE_TEXT }, o).body
}
