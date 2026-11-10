# 更新说明

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
