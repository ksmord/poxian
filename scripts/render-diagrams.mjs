// Render the README's two mermaid diagrams to SVG via mermaid.ink, so the
// README can embed images that render everywhere (GitHub renders mermaid
// natively; editors and the magpie plugin page often don't).
//   node scripts/render-diagrams.mjs
import { writeFileSync, mkdirSync } from "node:fs"
import { deflateRawSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, "docs")
mkdirSync(out, { recursive: true })

const diagrams = {
  "architecture.svg": `flowchart LR
    subgraph agents["Agents (any that route through magpie)"]
        A1["Claude Code<br/>(anthropic)"]
        A2["Codex / OpenCode / ZCode / DSH…<br/>(chat · responses)"]
        A3["Gemini CLI<br/>(gemini)"]
    end
    subgraph magpie["magpie gateway · 127.0.0.1:3425"]
        MW["poxian middleware<br/>onRequest(body, ctx)"]
        RT["routing · accounts · fallback"]
    end
    P["Providers<br/>(Anthropic / OpenAI-compatible / Gemini / relays)"]
    A1 & A2 & A3 --> MW
    MW -- "system prompt injected<br/>at each protocol's own place" --> RT
    RT --> P
`,
  "sequence.svg": `sequenceDiagram
    autonumber
    participant U as User
    participant A as Agent (e.g. Claude Code)
    participant M as magpie gateway
    participant H as poxian onRequest(body, ctx)
    participant P as Provider
    U->>A: task
    A->>M: POST /v1/… (agent's own system prompt inside)
    M->>H: body, ctx (protocol, agent, model, options)
    H->>H: agents/models filter?
    H->>H: pick position per protocol<br/>(system · messages[0] · instructions · systemInstruction)
    H-->>M: body with your prompt prepended
    M->>P: routed (account pooling, fallback)
    P-->>M: reply
    M-->>A: reply
    A-->>U: answer under the workbench contract
`,
}

const b64url = (b) => b.toString("base64url")
async function render(name, code) {
  // mermaid.ink first, kroki as fallback
  for (const [tag, url] of [
    ["mermaid.ink", "https://mermaid.ink/svg/" + b64url(Buffer.from(code, "utf8"))],
    ["kroki", "https://kroki.io/mermaid/svg/" + b64url(deflateRawSync(code, { level: 9 }))],
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) { console.error(name, tag, "->", res.status); continue }
      const svg = await res.text()
      if (!svg.startsWith("<svg")) { console.error(name, tag, "-> not svg"); continue }
      writeFileSync(join(out, name), svg)
      console.log(name, "via", tag, svg.length, "bytes")
      return
    } catch (e) { console.error(name, tag, "->", e.message) }
  }
  process.exit(1)
}
for (const [name, code] of Object.entries(diagrams)) await render(name, code)
