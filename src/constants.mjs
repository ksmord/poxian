// 常量：注入标记、激活词、Anthropic 缓存断点。
// 纯数据模块，不碰 fs，同步中间件壳与异步钩子入口共用。

// 幂等标记：注入内容的首行。已带标记的请求不再二次注入。
export const MARK = "<!--poxian-->"

// 激活词。moejs 下 Set.has 对 CJK 有坑，调用方一律用 indexOf。
export const ACTIVATION = ["寒霜", "自检", "SELF-CHECK"]

// Anthropic prompt caching：一个请求最多 4 个 cache_control 断点。
export const CACHE = { type: "ephemeral" }
export const CACHE_LIMIT = 4

// 激活词轻路由用的握手指令：只回固定一行，不执行的任何工具。
export const HANDSHAKE_TEXT = [
  "You are the poxian workbench kernel. The user's message is an exact activation word, not a task.",
  "- If the message is exactly 寒霜: reply with exactly this one line and nothing else:",
  "  寒霜 ready · 主内核已加载 · 红蓝双档待命 · 给目标或场景",
  "- If the message is exactly 自检 or SELF-CHECK: reply with exactly: 全系统正常。继续。",
  "Never use tools; never add commentary; reply with the fixed line only.",
].join("\n")

// 默认值。与 package.json 的 magpie.options 保持同一套键。
export const DEFAULTS = {
  enabled: true,
  override: true,          // false = 请求已自带 system prompt 时跳过
  position: "prepend",     // prepend | append
  cache: false,            // Anthropic cache_control 断点
  handshake: true,         // 激活词轻路由
  handshake_model: "",     // 握手请求改派模型
  models: [],              // 模型名前缀白名单
  agents: [],              // agent 白名单（优先于 agents_off）
  agents_off: [],          // agent 黑名单
  prompt: "",              // 内置版本 id：v52 / v5 / v4 / v3
  prompt_path: "",         // 外部 .md/.txt 路径（优先于 prompt）
  on_prompt: "",           // 字面文本（优先于 prompt_path）
  strip_frontmatter: true, // 剥掉 md 开头的 --- 段
  gatewayTimeoutMs: 3000,  // 读文件超时，超时即放行原请求
  log: true,
  log_path: "~/.magpie/logs/poxian.jsonl",
}
