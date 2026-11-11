# 更新说明

## 0.1.0 · 架构重构：同步中间件 → 异步钩子

参照 `magpie-system-prompt-file` 的挂载方式重做数据流。**payload 生命周期不再绑死进程生命周期**，
这是 0.0.x 那一串「配置写 v5、实际跑 v3」问题的根因。

### 挂载点

- `magpie.middleware`（同步引擎，无 `node:fs`）→ **`magpie.hooks`**（Bun host，异步，有 fs）
- 入口 `poxian.hooks.mjs`：`export async function onRequest(body, ctx)`
- `poxian.middleware.js` 保留为兼容壳，老配置仍可加载；语义用 `normalize` + 旧 cache 默认值对齐

### payload 外置

- 新增 `prompt_path`：外部 `.md` / `.txt`，**每请求 `stat`**，`mtimeMs`+`size` 双键缓存，
  改完下一次请求即生效，不构建、不重启
- 优先级：`on_prompt`（字面）> `prompt_path`（文件）> `prompt`（内置版本）
- 文件读失败**不阻断请求**：记 `fallback:<code>` 后退回内置版本
- 解码补齐：UTF-8 BOM / UTF-16 LE&BE / 无 BOM UTF-16 探测 / CRLF / frontmatter 剥离
- 路径展开：`~`、`$VAR`、`${VAR}`、`%VAR%`，相对路径对 `ctx.cwd` 解析；
  Windows 盘符 / UNC 原样透传，不在非 Windows 上改写

### 失败语义

- `gatewayTimeoutMs`（默认 3000）包住 payload 解析，超时 / 任何异常 → 返回 `undefined`
- 返回 `undefined` = 请求原样放行，这是 magpie 钩子契约的逃生门
- 0.0.3 那条「订阅代理渠道请求挂住」属于同一类：钩子不许有阻塞路径

### 协议适配器

- 345 行单文件 4 个 if 分支 → `src/adapters/` 注册表，每个适配器只实现
  `read / write / replace` 三个方法
- 新增协议 = 加一个文件 + 在 `index.mjs` 登记，`core.mjs` 不动
- 修正 Gemini：原先对 `systemInstruction` / `system_instruction` 的写入不统一，
  现在保留请求已用字段名，统一按 `{parts:[...]}` 写回

### 观测

- 每请求一行 JSONL（默认 `~/.config/magpie/logs/poxian.jsonl`，超 2 MB 滚存 `.1`）：
  `{ts, agent, model, action, src, bytes, ms, protocol, position}`
- `action` 取值可直接定位问题：`inject` / `handshake` / `skip-mark` / `skip-override` /
  `skip-agent-off` / `skip-agent-list` / `skip-model` / `skip-protocol` / `error`

### 测试

- 新增 `test/hooks.test.mjs`：`node --test test/` → 21 例全绿
- 旧 `cases.json` 快照 22/22 仍全绿（兼容壳的 cache 默认值保持旧语义）

## 0.0.6

修「保存按钮永远失败」——这是诊断最久的一个，根因不在页面表单，而在桥接回执。

### 实测定位（监听 magpie 父页面 API + 读磁盘验证）

- 页面发出的**写入其实全部落盘了**（磁盘配置与用户点击完全一致）
- 但 magpie 父窗口发回沙箱 iframe 的**回执永远收不到**：父页面先落盘、后发回执，
  回执对不透明源（`sandbox="allow-scripts"`）的 iframe 被丢
- 页面等 6 秒超时后误报「写入失败」，脏标记不清零；再点保存又撞上 magpie 的
  「每页每秒最多写一次」限流，反复失败——UI 观感与真实状态完全脱节

### 修复

- **保存/点选提示词改为乐观提交**：界面立即生效、脏标记立刻清零，不再卡 6 秒等回执
- **写入走后台串行队列**：≥1.1s 间隔落盘（避开限流），期间多次改动自动合并为最新一份，
  撞限流自动退避重试；后台写入期间用户又改动表单的话，不会覆盖界面
- **顶层直开守卫**：单独打开页面时 bridge 的 parent 是页面自己，调用会「自问自答」
  瞬间返回 undefined（写入根本到不了 magpie）——现在明确显示
  「独立预览 · 请从 magpie 侧边栏打开」，不再假装能存
- **静态资源加 `?v=` 版本参数与 no-store**，杜绝 WebView 缓存旧脚本导致的"改了没反应"

### 已知限制

无回执模式下刷新页面后，界面可能回到默认显示（沙箱 iframe 里 localStorage 不可用，
读不回已存配置）——磁盘配置不受影响，以保存过的为准；可用
`magpie plugin options poxian` 查看真实值。

---

## 0.0.5

### 修复

- **保存结果不再"报喜不报忧"**
  `options.set` 在现版本桥接上不保证回传新值（实测返回 `undefined`），能不能读回也不稳定。
  0.0.4 之前一律 toast「已保存」，实际没落盘也这么说。现在写入后立刻 `options.get()` 回读比对：
  一致才显示「已保存」；读不回来显示「已写入 / 读回校验未通过（界面用本地镜像回显）」，
  状态栏也会区分「可读写」与「本地镜像」。

### 说明

- 沙箱里的插件页（`sandbox="allow-scripts"`，不透明源）**只能**通过 `_magpie/bridge.js` 与 magpie 通信，
  页面内直接 fetch 会被 CORS 挡掉。所以保存链路只有桥接一条，诊断必须靠回读。

## 0.0.4

修控制台「保存不生效 / 刷新就丢 / 显示不全」三件事。

### 修复

- **保存会把没动过的配置清空**
  magpie 的 `options.set` 是**整份替换**，不是合并。0.0.3 及之前 `formToOptions()` 只回传
  「与默认值不同」的键（稀疏对象），于是每次保存都会把未改动的 `prompt` / `models` /
  `agents_off` / `handshake_model` 一起抹掉——表现就是"改一个开关，别的设置跟着丢了"。
  现在一律产出完整对象，每个键写明确值。点选提示词那条路径同样改为「以当前生效值为底整份写入」。

- **启动时报 ReferenceError，页面被判成"桥接无响应"**
  启动段残留了 `writeLS(v)`，而 `v` 已被删除，抛异常后被 catch 吞掉，状态直接显示
  「桥接无响应 · 只读」。已重写整个回读段。

- **`options.get` 读不回配置时界面显示默认值**
  这版桥接的 `options.get()` 实测返回 `undefined`（写入本身是成功的，`plugins.json` 里有值）。
  现在读不到就用最近一次写入成功的**本地镜像**回填界面，状态标「已连接 · 本地镜像」并提示，
  不再让人误以为配置丢了。

- **两处文字被裁切**
  概要条的「注入体量」（`~3,864 tok`）原来 `white-space: nowrap` + 省略号，窄屏下被切；
  命令区 `cmd2` 的长 JSON 同理。两处都改成可换行（`overflow-wrap: anywhere`），完整显示。

---

## 0.0.3

修的是「插件一开，agent 连不上网关」——最严重的一条。

### 修复

- **`cache` 默认改为关闭**
  0.0.1/0.0.2 默认 `cache: true`，会给 Anthropic 协议的注入块加 `cache_control: {type:"ephemeral"}`。
  这对**真 Anthropic 端点**是省钱手段（大前缀命中后约 1/10 价），但对**订阅代理渠道**
  （WorkBuddy / Trae / SenseNova 这类中转）兼容性参差不齐：Claude Code 自身请求已带 2~3 个
  断点，再叠加 poxian 的就会踩满 Anthropic 的 4 断点上限，部分代理直接拒绝或挂住不返回——
  表现为 agent 半天连不上，只有停用插件才恢复。

  上游 fork 源 `YaoGuaiLi/hangong` 从不注入 `cache_control`，所以上游没有这个问题。
  现在默认对齐上游行为，需要真 Anthropic 缓存时在控制台手动打开。

  控制台文案同步改成「仅真 Anthropic 端点建议开……订阅代理渠道可能不兼容，会表现为请求挂住」。

### 验证方式

开启插件后连续发请求看首字节时间。若此前出现「连不上 / 长时间无响应」，关掉 `cache` 后应立即消失。

---

## 0.0.2

修的是 0.0.1 控制台页面的两个硬伤。

### 修复

- **控制台显示「未连接」且点什么都不动**
  `page/index.html` 漏掉了 `<script src="_magpie/bridge.js"></script>`。
  没有这行，magpie 不会把 `window.magpie` 注入进插件页，页面拿不到桥接句柄：
  状态显示「未连接 · 独立预览」，所有按钮和开关的写入分支直接返回，看起来就是"页面停止工作"。
  已按官方插件页（如 Usage glance）的写法补回，放在 `<head>` 里、其余脚本之前。

- **选中态记到了错误的 localStorage 键**
  `page/app.js` 的 `LS_KEY` 写成了一个占位符字面量，键名不是预期值。
  已改为稳定的 `poxian.prompt`。

### 升级方式

magpie 界面 → 插件 → 已安装 → poxian → 检查更新 / 移除后重装，或直接：

```
magpie plugin rm poxian
magpie plugin add github:ksmord/poxian
```

升级前如果本地已有 0.0.1，建议先移除再装——版本号变小的情况 magpie 不会主动提示降级。

---

## 0.0.1

首个自用版本，相对 1.4.0 的改动：

- 版本号 1.4.0 → 0.0.1
- **图标**：`icon.svg` 复制进 `page/` 并改相对路径 + favicon（原来用 `../assets/icon.svg`，跨父目录被插件沙盒挡住，必然裂图）
- **桥接**：`magpie.ready` / `options.get` / `options.set` 全部加超时兜底，状态改为三态（已连接 / 未连接 / 无响应）；不再无限停在「连接中…」
- **选中态**：`package.json` 补全 `magpie.options` 默认键（原来只登记 `override` / `position`，其余键写不进持久层），并加 localStorage 镜像；点一行即写入生效，刷新后仍保持选中
- **删除英文变体**：`prompts/variantb.md` 及构建脚本里的条目一并移除
- **控制台重做**：零依赖单文件，概要条 + 分区卡片 + 底部操作条；每档提示词直接标字数与估算 token，超过 8k 标黄
- **配色跟随 magpie**：读桥接的 `dark` 与 `tokens`，按别名映射到 `--accent / --bg / --card / --fg / --muted / --line / --ok / --warn`，强调色派生选中底色
- **性能**：默认提示词改为轻量 V5（约 3.9K token），完整版 v5.2（约 21K token）保留可选

### 性能实测

同一份固定 60 轮对话历史（7,572 token）走真实网关，各 3 次取中位数：

| 场景 | prompt tokens | 中位耗时 | 相对增量 |
|---|---|---|---|
| 插件关闭（无注入） | 7,572 | 1.94 s | — |
| 开启 · 轻量 V5 | 11,495 | 2.05 s | +0.11 s / +6% |
| 开启 · 完整版 v5.2 | 28,355 | 2.36 s | +0.42 s / +22% |

中间件本身 36–65 µs/请求，不是瓶颈；成本全在注入体积，约每 1K token +0.02 s prefill。
