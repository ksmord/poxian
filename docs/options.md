# 选项全表

命令行读写：

```bash
magpie plugin options poxian                         # 读当前全部选项
magpie plugin options poxian '{"enabled":false}'     # 合并写入
```

应用内：插件 → 已安装 → `poxian` → 选项（表单字段由 `page/app.js` 的 `SCHEMA` 声明，与 `package.json` 的 `magpie.options` 由 `npm run check` 校验一致）。

## 基础

| 选项 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总闸。`false` 时什么都不做 |
| `override` | `true` | 请求已带系统提示词时是否仍注入 |
| `override_mode` | `"replace"` | `replace` 整段替换自带 system（默认，实机验证唯一能拿到控制权的方式）/ `merge` 保留原生 system 并拼接 |
| `position` | `"prepend"` | 仅 `override_mode=merge` 时生效：`prepend` 前置 / `append` 追加。实测拼接无论前置还是追加都无法让注入取得控制权 |
| `gatewayTimeoutMs` | `3000` | 读 payload 的超时。超时/异常一律放行原请求 |
| `skip_stream` | `false` | `true` 时流式请求直接跳过。识别 `body.stream`，以及 Gemini 的 `:streamGenerateContent` |
| `dry_run` | `false` | 全流程照跑（含日志与 `payload_sha256`），但原请求一个字节不改。用来看"如果注入会发生什么" |

## 提示词来源（优先级从高到低）

| 选项 | 默认 | 含义 |
|---|---|---|
| `on_prompt` | 无 | 字面文本，优先级最高（调试用，不进文件） |
| `prompt_path` | 空 | 外部 `.md` / `.txt` 路径。每请求 `stat`，改完即生效，优先于内置版本库。支持 `~`、`$VAR`、`%VAR%`、相对 `ctx.cwd` 的路径 |
| `prompt` | `"v5"` | 内置版本 id 回退：`v52` / `v5` / `v4` / `v3` 及各人格精简版。`prompt_path` 未设或读失败时使用 |
| `strip_frontmatter` | `true` | 剥掉 `.md` 开头的 `---` 元数据段 |
| `max_payload_bytes` | `0` | 载荷字节上限。`0` = 不限制。超限时降级回内置版本，日志打 `oversize` + `requested_bytes` |
| `prompt_allowlist` | `[]` | `prompt_path` 允许的目录前缀。空 = 不限制。非空时越界路径直接回退内置版本，日志打 `path_blocked` |

## 作用域

| 选项 | 默认 | 含义 |
|---|---|---|
| `agents` | 全部 | 仅对这些 Agent 生效，如 `["claude","codex"]` |
| `agents_off` | 空 | 排除这些 Agent，其余仍注入（先于白名单判定，握手也绕不过） |
| `models` | 全部 | 仅对这些模型名前缀生效，如 `["glm-","deepseek"]` |

## 握手轻路由

| 选项 | 默认 | 含义 |
|---|---|---|
| `handshake` | `true` | 激活词轻路由总开关。末条用户消息恰好等于激活词时，走短回复而不是整份提示词 |
| `handshake_model` | 无 | 握手请求改派到该模型 |

## 缓存与观测

| 选项 | 默认 | 含义 |
|---|---|---|
| `cache` | `false` | Anthropic `cache_control` 断点。仅真 Anthropic 端点建议开：中转渠道兼容性不一，叠加客户端自带断点会踩满 4 个上限 |
| `log` | `true` | 每请求写一行 JSONL 观测记录 |
| `log_path` | `~/.config/magpie/logs/poxian.jsonl` | 观测日志路径，超过 2 MB 自动轮转 |
| `log_backup_count` | `1` | 轮转备份份数。`1` = 只留 `.1`，最大 `9` |

## 报文清洗

| 选项 | 默认 | 含义 |
|---|---|---|
| `enable_message_filter` | `false` | 清洗总开关。开 = 注入前先删掉请求自带的冲突 system 与拒绝式 assistant 历史 |
| `strip_safety_system` | `true` | 子项：删命中关键词的 system 位。四种协议都认（chat 的 `system`/`developer` 消息、Anthropic 的 `system`、Responses 的 `instructions`、Gemini 的 `systemInstruction` / `system_instruction`） |
| `strip_deny_assistant` | `false` | 子项：删历史里「抱歉 / 不能 / 无法」一类整条 assistant 回复。删完会合并相邻同角色消息，否则 Anthropic 要求交替会直接 400 |

## 注入档位

默认 `always`：每轮全量，与旧版一致。另外两档是省 token 的可选项，判定在 `src/policy.mjs`（纯函数，可单测）。

| 选项 | 默认 | 含义 |
|---|---|---|
| `inject_mode` | `"always"` | `always` 每轮全量 / `tiered` 首轮·拒答后·风险·每 N 轮全量，其余骨架 / `on_refusal` 只有锁存命中才注入 / `off` 全关 |
| `skeleton_prompt` | `"fujiang-lite"` | 骨架用的内置版本 id。默认取已实测的 897 tok 版本，不引入没跑过数据的自造小抄 |
| `skeleton_path` | 空 | 骨架用外部 `.md`；设了就优先于 `skeleton_prompt` |
| `refusal_ttl_ms` | `300000` | 拒答锁存有效期。太短漏补救窗口，太长让一次误判拖着整个会话 |
| `latch_max` | `512` | 锁存容量上限，超限淘汰最旧。内存 Map 不设上限就是慢性泄漏 |
| `risk_preempt` | `true` | `tiered` 下按高风险意图表提前上全量，补「拒答后下一轮才补救」的那一轮缺口 |
| `tier_full_every` | `0` | `>0` 时每 N 轮补一次全量；`0` = 只在首轮/拒答/风险时补 |

行为细节：

- **锁存命中时顺手清洗**：`tiered`/`on_refusal` 注入前会开 `enable_message_filter` 与 `strip_deny_assistant`，删掉历史里模型自己那句「我不能」，否则模型看着自己上一句再拒一遍。
- **判不出来就不动**：流式空壳、抽不到正文时 `refusal=null`，既不清锁存也不打标记。用一次假阴性关掉人格，比多注入一轮贵得多。
- **键会断**：会话键是 `agent|model|首条 user 文本前 160 字` 的 FNV 指纹。历史压缩、换客户端都会换键，锁存随之失效——这是它只能当加速档的原因。
- **内存不落盘**：重启清空。刻意如此，避免一次误判跨进程存活。

## 探针

探针用来区分三件事：字节有没有写进去（日志 `injected`）、模型有没有读到（回显）、读到后认不认（行为）。

| 选项 | 默认 | 含义 |
|---|---|---|
| `probe_echo` | `false` | 回显探针。追加一枚 6 位随机标记，要求模型回复首行原样吐出。回显到 = 注入真的拿到了控制权。约 +20 token，会改请求体，默认关 |
| `probe_echo_position` | `message` | 落点。`message` = 最后一条 user 消息尾部（默认）；`payload` = 0.1.x 旧行为，拼到注入载荷末尾、跟着进 `system`。别随便改回 `payload`：`system` 是缓存前缀的头，每请求换一枚 nonce，上游逐 token 比对会从 nonce 处断链（实测 workbuddy 79.4% → 1.3%） |
| `probe_refusal` | `false` | 拒答探针。只读回复前 200 字符判是否拒答，不改请求、零 token 成本。单用只能知道「这次拒了」，配回显探针才能区分「没送到」与「送到了不认」 |

## 预填

| 选项 | 默认 | 含义 |
|---|---|---|
| `prefill` | `""` | 请求末尾补一条 assistant，内容就是工件首行（围栏、`1. `、标题）——把模型的第一个 token 从「要不要答」挪到「这段怎么接」。会改请求体，默认关 |
| `prefill_models` | `[]` | 预填白名单，按模型名前缀匹配。写死它就等于关掉自动判断 |
| `prefill_auto` | `true` | 没写白名单时按「先验 + 该路由滑动统计」自动决定。先验来自实机：`hy4` 71%→93%、`dp4.1f` 71%→38%、`k3` 系 0%、`glm` 无增益。统计是进程内 EWMA，`n≥4` 才动手；连续拒答会把已开的路由翻成关 |
