# prefilter · 只清洗、不注入的入口变体

## 它是什么

`hooks.mjs` 是 poxian 的**第二个钩子入口**，与根目录的 `poxian.hooks.mjs` 并列。
两者共用同一份清洗实现 `../src/filter.mjs`，区别只在一件事：

| 入口 | 做什么 |
|---|---|
| `../poxian.hooks.mjs` | 注入提示词；报文清洗由 `enable_message_filter` 决定 |
| `./hooks.mjs` | **只**清洗报文，不注入任何提示词 |

## 为什么没有 `package.json`

这里刻意**不放清单文件**。

`hooks.mjs` 用相对路径 `import "../src/filter.mjs"`，它依赖 poxian 包内的 `src/`。
把它当作独立目录安装时，magpie 会按清单里的 `magpie.hooks` 去找入口，
而入口一旦脱离包根就 `ERR_MODULE_NOT_FOUND` —— 这正是 0.1.1 之前
`prefilter/package.json` 指向不存在的 `./hooks.mjs` 时的那种失败。

所以：**它不是独立插件，是 poxian 的一个入口变体。** 不带清单，就不会被误装。

## 怎么用

改 poxian 自己的 `magpie.hooks` 指向这里（在 poxian 包根目录的 `package.json` 里）：

```json
{
  "magpie": {
    "hooks": "./prefilter/hooks.mjs",
    "options": {
      "enabled": true,
      "strip_safety_system": true,
      "strip_deny_assistant": false
    }
  }
}
```

选项读取兼容两种写法：嵌套的 `ctx.options.magpie.options`，以及已拍平的顶层键。
`enabled` 必须显式为 `true` 才动作 —— 这个壳的唯一价值就是清洗，默认关。

## 和主入口同时开

同一请求会被清洗两遍。清洗是幂等的（第二遍没有可删的东西，
`filterMessages` 返回原引用），但会白付一次克隆。**不要两个都挂。**

## 关键词表在哪

在 `../src/filter.mjs` 的 `SAFETY_KEYWORDS` / `DENY_PHRASES`。
只有这一份。改这里，两个入口同时生效。