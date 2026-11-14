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
  // replace = 请求自带 system 时整段替换（实机验证：拼接无法让注入取得控制权）
  // merge   = 旧行为，按 position 拼接。保留给「必须保留原生 system」的场景
  override_mode: "replace",
  position: "prepend",     // prepend | append（仅 override_mode=merge 时有意义）
  cache: false,            // Anthropic cache_control 断点
  handshake: true,         // 激活词轻路由
  handshake_model: "",     // 握手请求改派模型
  models: [],              // 模型名前缀白名单
  agents: [],              // agent 白名单
  agents_off: [],          // agent 黑名单，最先判（黑名单优先于白名单，握手也绕不过）
  prompt: "",              // 内置版本 id：v52 / v5 / v4 / v3
  prompt_path: "",         // 外部 .md/.txt 路径（优先于 prompt）
  on_prompt: "",           // 字面文本（优先于 prompt_path）
  strip_frontmatter: true, // 剥掉 md 开头的 --- 段
  gatewayTimeoutMs: 3000,  // 读文件超时，超时即放行原请求
  log: true,
  log_path: "~/.config/magpie/logs/poxian.jsonl",
  log_backup_count: 1,     // 轮转备份份数；1 = 与旧版一致（只留 .1）
  skip_stream: false,      // true = 流式请求直接跳过注入
  dry_run: false,          // true = 全流程照跑，但原请求一个字节都不改
  max_payload_bytes: 0,    // 0 = 不限制；>0 且超限 → 降级回内置版本，并打 oversize 标记
  prompt_allowlist: [],    // prompt_path 允许的目录前缀；空 = 不限制（保持旧行为）

  // ============ 新增报文清洗配置默认值 ============
  enable_message_filter: false,   // 报文清洗总开关，默认关闭，兼容旧行为
  strip_safety_system: true,      // 移除安全约束类 system，开启清洗时生效
  strip_deny_assistant: false,   // 过滤历史 assistant 拒绝回复，默认关闭

  // ============ 探针 ============
  // 回答的是「注入有没有真的拿到控制权」，不是「字节写没写进去」。
  // 详见 src/probe.mjs 开头的实测记录：同一份载荷在不同路由上，服从与拒绝并存。
  probe_echo: false,     // 追加回显标记，约 +20 token，会改请求体
  // 回显标记的落点。message = 最后一条 user 消息尾部（默认，保缓存前缀）
  // payload = 旧行为，追加到注入载荷末尾（进 system，会切断上游前缀缓存）
  probe_echo_position: "message",
  probe_refusal: false,  // 只读回复前 200 字符判拒答，不改请求，零 token 成本
  // 预填：把回复首行预先写成工件开头，模型只能往下续。
  // 实测 hy4 71% → 93%，dp4.1f 反而 71% → 38%，所以默认关、必须按路由开。
  prefill: "",
  prefill_models: [],
  // 没写白名单时，按「先验 + 该路由滑动统计」自动判断开不开。
  prefill_auto: true,

  // ============ 注入档位 ============
  // always     每轮全量（默认，与 0.2.7 一致）
  // tiered     首轮 / 拒答后 / 高风险预判 / 每 N 轮 → 全量；其余 → 骨架
  // on_refusal 只有拒答锁存命中才注入，其余零 token（极端省法，接受首轮裸奔）
  inject_mode: "always",
  // 骨架载荷：默认取已实测的 fujiang-lite（897 tok），不引入没跑过数据的第三份小抄。
  // 留空 = 退回全量，宁可多花 token 也不要在「以为省了」的状态下裸奔。
  skeleton_prompt: "fujiang-lite",
  skeleton_path: "",
  // 拒答锁存有效期。太短会把补救窗口漏掉，太长会让一次误判拖着整个会话走。
  refusal_ttl_ms: 300000,
  // 锁存容量上限，超限淘汰最旧；内存里不设上限就是慢性泄漏。
  latch_max: 512,
  // 高风险意图预判：在拒答发生之前就把全量挂上，补 on_refusal 补不上的那一轮。
  risk_preempt: true,
  // >0 时每隔 N 轮补一次全量（0 = 不按轮补，只在首轮/拒答/风险时补）。
  tier_full_every: 0,
}

// 运行态协议号：与 page/versions.js 的 window.PX_EXPECT_PROTO 配对。
// 页面刷新拿新 bundle、Bun plugin host 没重启时立刻判定错配，禁用写入。
export const API_PROTO = 3
