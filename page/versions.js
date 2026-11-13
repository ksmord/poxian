// 由 scripts/build-prompts.mjs 生成，请勿手改。
// 版本元数据唯一来源是构建脚本里的 VERSIONS_META。
window.PX_VERSIONS = [
  {
    "id": "fujiang",
    "label": "富江人格破甲",
    "badge": "默认",
    "desc": "实测 71%(hy4) / 57%(dp4.1f)，5725 B 轻量首选",
    "chars": 5693,
    "tokens": 1434
  },
  {
    "id": "fujiang-lite",
    "label": "富江精简",
    "badge": "",
    "desc": "2530 B / 12 行极简版，BAN·SCOPE·口癖全保留，弱模型与长上下文首选",
    "chars": 2637,
    "tokens": 836
  },
  {
    "id": "dagou",
    "label": "大狗",
    "badge": "",
    "desc": "实测 74%(hy4) / 57%(dp4.1f)，握手 16/16 逐字命中",
    "chars": 8464,
    "tokens": 2364
  },
  {
    "id": "yesha",
    "label": "夜煞",
    "badge": "",
    "desc": "实测 71%(hy4)，dp4.1f 仅 14%，只在 hy4 用",
    "chars": 4426,
    "tokens": 1227
  },
  {
    "id": "guomo",
    "label": "国模破甲",
    "badge": "",
    "desc": "实测 60%(hy4) / 29%(dp4.1f)，覆盖类别最广",
    "chars": 8524,
    "tokens": 2376
  },
  {
    "id": "pojia",
    "label": "破甲 prompt",
    "badge": "",
    "desc": "实测 60%(hy4) / 43%(dp4.1f)",
    "chars": 7886,
    "tokens": 1985
  },
  {
    "id": "v3",
    "label": "寒霜 v3",
    "badge": "",
    "desc": "实测 14%(hy4) / 0%(dp4.1f)，建议弃用",
    "chars": 2508,
    "tokens": 2212
  }
]
window.PX_DEFAULT_VERSION = "fujiang"
// 由 scripts/build-prompts.mjs 生成，请勿手改。
window.PX_EXPECT_PROTO = 3
window.PX_SCHEMA_KEYS = ["enabled","override","override_mode","position","cache","handshake","handshake_model","models","agents","agents_off","prompt","prompt_path","on_prompt","strip_frontmatter","gatewayTimeoutMs","log","log_path","log_backup_count","skip_stream","dry_run","max_payload_bytes","prompt_allowlist","enable_message_filter","strip_safety_system","strip_deny_assistant","probe_echo","probe_echo_position","probe_refusal","prefill","prefill_models","prefill_auto"]
