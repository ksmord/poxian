# 网关中间件的几类经典缺陷与通用写法规约

> 只写与具体载荷无关的工程机制：布尔归一、自证比对、写入守卫、互斥条件、
> 记账口径、变更验证、文档漂移。不涉及注入链设计、载荷内容、补救策略。
>
> 适用面比任何单个项目都宽：网关、反向代理、SDK 拦截器、客户端 hook、
> eBPF 前置——只要在请求/响应边界上读写报文，都会踩到下面这几类。

---

## 1. 布尔归一：三态白名单，默认落安全侧

### 症状

```js
const enabled = o.enabled !== false          // ❌
const cache = o.cache || true                // ❌ 恒为 true
```

`"false" !== false` 为真，字符串 `"false"` 被判成 `true`。
`x || true` 更直接——左侧为 falsy 时取右侧，result 永远真。

真实表现：设置页把开关关了，配置文件里是 `"enabled": "false"`，
请求照样被改写。用户看到的是"关了没用"，读代码看逻辑又是对的。

### 为什么会中

布尔值的来源通常不止一处：JSON 配置、URL query、表单提交、环境变量、
命令行参数。后三者天然是字符串。只要有一处没做类型收窄，
`!== false` / `||` / `Boolean()` 就会把字符串当真值。

### 写法

```js
const TRUE_SET  = new Set([true, 1, "1", "true", "on",  "yes", "enable",  "enabled"])
const FALSE_SET = new Set([false, 0, "0", "false", "off", "no",  "disable", "disabled"])

/**
 * 三态布尔归一。
 * @param {unknown} v 原始值
 * @param {boolean} fallback 无法识别时取的值——必须选"错了不伤数据"的那一侧
 */
export function toBool(v, fallback = false) {
  if (typeof v === "string") v = v.trim().toLowerCase()
  if (TRUE_SET.has(v)) return true
  if (FALSE_SET.has(v)) return false
  return fallback
}
```

### 必须想清楚的三件事

**一、`""` 归哪边。** 表单没填和用户显式清空是两回事。
若 `""` 表示"未提供"，走 fallback；若表示"用户关掉了"，归 false。
两种都成立，写进注释，别让下一个人猜。

**二、`"0"` 必须 false。** `Number("0")` 是 0，但 `"0" !== false` 为真。
这是最常见的漏网，而且只在"配置从 JSON 字符串化过一遍"时暴露。

**三、fallback 的方向。** 判据是"识别失败时，哪种结果更不容易造成损害"：

| 开关性质 | fallback | 理由 |
|---|---|---|
| 会改写或删除报文 | `false` | 不认识就当关，宁可少干 |
| 只做观测/计数 | `false` | 少记一条不会坏数据 |
| 安全阀（限流、熔断、超时） | `true` | 不认识就当危险，宁可多拦 |

### 唯一入口原则

归一只能在**配置加载的唯一边界**做一次，下游一律假定已经是 `boolean`。
同一个键在两处归一，必然出现"这处 true 那处 false"的漂移，
而且漂移只在特定配置组合下暴露，测试极难覆盖。

### 断言清单

表驱动跑一遍，比逐个 `assert` 可靠：新发现的怪值直接往表里补一行。

```js
const cases = [
  [true, true], [false, false],
  [1, true], [0, false],
  ["1", true], ["0", false],
  ["true", true], ["TRUE", true], [" true ", true],
  ["false", false], ["False", false], ["off", false], ["no", false],
  ["", false],
  [null, false], [undefined, false], [[], false], [{}, false], [NaN, false],
]
for (const [input, want] of cases) {
  assert.equal(toBool(input), want, `toBool(${JSON.stringify(input)})`)
}
```

注意最后四个：`[]`、`{}`、`NaN` 都是"看起来像假值"的怪输入。
`[]` 在 `!== false` 下判真、在 `Boolean()` 下判真、在 `|| true` 下判真，
三种错法各不相同——表格能一次抓住全部。

---

## 2. 自证类代码：两个时刻的快照，键序稳定的序列化

### 症状

```js
const proof = verifyPassthrough(body, body)   // ❌ 恒为真
```

同一个引用跟自己比，永远相同。"证明我没改报文"退化为"证明这个对象等于它自己"。
代码看着有自证，实际一个字节都没验。

### 正确结构

自证的本质是**跨时刻比对**，所以必须有两个独立快照：

```js
// ① 进入链路之前
const beforeSha = snapshot(body)      // 深拷贝后序列化，不持有原引用

// ② 走完全部逻辑，所有分支都不许碰 beforeSha

// ③ 放行之前
const afterSha = snapshot(body)
const untouched = beforeSha === afterSha
```

三条必须守住的边界：

1. **快照是拷贝，不是引用。** `structuredClone` 深拷，或序列化后立刻丢弃原引用。
   持有引用 = 中间任何原地修改都会同时改掉"基准"，比对永远相等，
   病灶和原来一模一样，只是更隐蔽。

2. **中间环节不许改那份快照。** 谁改谁负责；最省事的办法是让快照是不可变字符串，
   想改也改不了。

3. **拍照位置要最早。** 晚一步就漏掉前面环节的改动。
   钩子入口第一行就该拍，别放在解析完之后。

### 键序问题

`JSON.stringify({a:1,b:2})` 与 `JSON.stringify({b:2,a:1})` 输出不同。
对象经过重建（展开、`Object.assign`、schema 校验往返、JSON 反序列化）后
键序可能变化，于是"内容没变但字符串变了"，自证误报"被改动"。

```js
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]"
  const keys = Object.keys(v).sort()
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}"
}
```

两条路线：

| 方案 | 覆盖 | 成本 | 适用 |
|---|---|---|---|
| 键序稳定序列化 | 全字段 | 随报文大小线性 | 默认选这个 |
| 白名单逐字段比较 | 只比关心的 | 低 | 字段多但只在意少数几个时 |

报文通常不大，选前者。数组顺序是语义的一部分，不能排序——只排对象键。

### 成本约束

自证要序列化两遍整包。大报文下这笔开销不能忽略（几 MB 的 base64、长上下文、
批量请求）。所以要能按需关闭。注意：**关闭开关本身也得走第 1 节的布尔归一**，
否则会出现"想关自证却关不掉"的二次故障。

### 一个常被忽略的点

"没改动"和"没注入"是两个结论，别混。

- `untouched = true` 说明本环节逐字透传
- `injected = false` 说明本次没有注入动作

放行路径上两者会同时为真，但语义不同。日志里分开记，
否则排查时看到 `untouched: true` 会误以为"注入成功了但内容没变"。

---

## 3. 写入路径的非空守卫

### 症状

```js
function replace(body, text) {
  body.system = text          // ❌ text 为 undefined 时把原有内容整个抹掉
  return body
}
```

结果不是"没注入"，而是"把用户原有的系统提示词删了"。
故障表现是"模型突然不守规矩了"，排查方向会被引向模型侧，离真凶很远。

### 写法

写入路径上的每个入口先判类型，判不过就原样返回，一个字都不动：

```js
function replace(body, text) {
  const t = typeof text === "string" ? text : ""
  if (!t.trim()) return body                 // 空载荷 = 不动作
  if (!body || typeof body !== "object") return body
  body.system = t
  return body
}
```

### 配套的四条

**一、返回值语义要写死。** `return body` 与 `return undefined` 的区别要在注释里钉住：
`undefined` 表示"放行、未改"，返回对象表示"改过了"。上层记账靠返回值判动作，
判不出来就会虚报改写次数。

**二、分支要能区分"改了"和"本来就这样"。** 原值已经等于新值时，
写进去也等于没改。要么比较后跳过并单独记账，要么统一记成"写入尝试"，
别把它算进"实际改写"。

**三、多键协议要互斥清理。** 同一语义在协议里可能有两套键（camelCase / snake_case）、
两种容器（字符串 / 块数组）。写一侧必须把另一侧删掉，否则旧值会盖掉新值：

```js
function writeInstructions(body, text) {
  if (body.systemInstruction)   delete body.systemInstruction
  if (body.system_instruction)  delete body.system_instruction
  body.systemInstruction = { parts: [{ text }] }
  return body
}
```

漏了这一步的表现很隐蔽：新注入生效了一半，另一半还是旧的，
模型行为看着"有时守规矩有时不守"，很难归因。

**四、数组容器的判空。** 期望是数组的字段拿到字符串时，
`arr.length` 是字符串长度、`arr.map` 直接抛。先 `Array.isArray`：

```js
function pushBlock(body, block) {
  if (!Array.isArray(body.system)) {
    // 原值是字符串或缺失 → 归一成数组，别在字符串上调 push
    body.system = typeof body.system === "string" && body.system.trim()
      ? [{ type: "text", text: body.system }]
      : []
  }
  body.system.push(block)
  return body
}
```

### 判断顺序

守卫的判据顺序会改变结果，务必固定成：**类型 → 非空 → 前置条件 → 写入**。
先判空再判类型，会在 `null` 上读 `.trim()` 而抛；先写再判，已经把数据毁了。

---

## 4. 互斥条件：动尾部之前先看尾部是什么

给对话补一条消息（预填、续写引导、格式提示），前提是"最后一条是普通对话消息"。
如果尾部是工具调用相关结构，补进去会破坏调用链：

| 协议 | 尾部工具结构的标志 |
|---|---|
| OpenAI Chat | `role: "tool"` / `role: "function"` / `assistant.tool_calls` 非空 |
| OpenAI Responses | `type: "function_call_output"` 等 output item |
| Anthropic Messages | 内容块里有 `tool_use` / `tool_result` |
| Gemini | `functionCall` / `functionResponse` parts |

```js
function tailBlocksAppend(body) {
  const msgs = body?.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return false
  const last = msgs[msgs.length - 1]
  if (!last || typeof last !== "object") return false

  if (last.role === "tool" || last.role === "function") return true
  if (Array.isArray(last.tool_calls) && last.tool_calls.length) return true
  if (Array.isArray(last.content)) {
    return last.content.some(b => b && (
      b.type === "tool_use" ||
      b.type === "tool_result" ||
      b.type === "function_call" ||
      b.functionCall || b.functionResponse
    ))
  }
  return false
}
```

原则：**拿不准就不动。** 少补一次提示是可接受的降级；破坏工具调用链是功能性故障，
而且故障点离代码很远（表现为 Agent 反复调用工具、死循环、参数错乱）。

### 同族问题的两个变体

- **角色交替约束。** Anthropic 要求 user/assistant 交替，连续两条同角色会被拒。
  补消息前要判末条角色，该合并就合并，该跳过就跳过。
- **尾部是 assistant 时的语义陷阱。** 在 assistant 消息后面接内容，
  有的协议当"续写"，有的当"新一轮"。想清楚要哪个，别靠试。

---

## 5. 记账口径：独立请求数 vs 发送次数

### 症状

一次逻辑请求被重发 N 次（超时重试、拒答重试、客户端自动重连），
如果每次发送都给"已处理"计数 +1，日志里的数字会被重试撑大。
真正要看的"有多少独立请求被处理过"反而被淹掉，扩容、限流、成本估算全部失真。

### 口径

```js
// attempt：每进入链路一次 +1，反映流量
// retry：重试 +1，不进主计数
// done：独立请求最终成功 +1

let rec = ledger.get(key)
if (!rec) { rec = { attempts: 0, retries: 0, done: 0 }; ledger.set(key, rec) }

if (isRetry) rec.retries += 1
else { rec.attempts += 1; if (ok) rec.done += 1 }
```

### 关键：重试的识别

重试和"用户真的又发了一次"在报文上可能一模一样。可用的判据：

- 客户端传入的请求 ID / `Idempotency-Key` 头
- 报文内容指纹（同一 key + 同一内容哈希 = 大概率是重试）
- 时间窗（N 秒内同指纹视为重试）
- 协议层的 `retry_count` / `x-retry-attempt`

都拿不到时，退化成"按内容哈希去重"，并在文档里写明这个口径的误差边界——
用户重复发同一句话会被算成一次重试。

### 三个恒等式，用来验口径对不对

```
attempts >= done + failed          （每条进入的请求都有结局）
attempts == fresh + retries        （或者 fresh 独立记）
done + failed + inflated == attempts
```

日志里随手 `grep` 一下这几个数，对不上就是口径漏了分支。
这一步比写单元测试便宜，值得放进发布检查。

---

## 6. 变更验证：静态阅读不算验证

### 症状

改完代码，眼睛过一遍，觉得对，写进 CHANGELOG，收工。
实际上一个分支都没跑过。这类"未验证的改动"混进发布，
故障会迟到很久才暴露，且暴露时已经找不到是哪次改动引入的。

### 最小验证梯度

按成本从低到高，每一步都能独立拦住一类问题：

| 级 | 动作 | 拦住什么 | 成本 |
|---|---|---|---|
| 0 | 语法/导入检查（`node --check`、`import()` 一遍） | 拼错、循环依赖、导出名不对 | 秒 |
| 1 | 纯函数单测（无 IO 的模块） | 逻辑错误、边界漏判 | 秒 |
| 2 | 契约测试（喂假 ctx 走完整链路） | 分支未覆盖、返回值语义错 | 秒 |
| 3 | 真实报文回放（脱敏样本） | 与真实协议形状的偏差 | 分钟 |
| 4 | 灰度/影子流量 | 线上才有的形状 | 小时 |

**新增文件必须同时进第 1 级。** 零测试覆盖的新模块是最高风险资产：
它没有历史行为可对照，出错时没有"以前是对的"这个参照。

### 提示词/配置类数据的验证

它不像代码那样有类型检查，四件事必须做：

1. **构建能跑通。** 生成产物与源一致，产物可被目标环境解析。
2. **指纹稳定。** 同一份源两次构建指纹相同；改动源后指纹必变。
3. **占位符闭合。** 所有 `{var}` / `${var}` 都能在变量表里找到定义，
   没有漏写右括号的畸形占位。
4. **长度与截断。** 产物超过目标字段的长度上限时会发生什么，
   要有明确行为（截断 / 报错 / 拒绝加载），并且测过。

第 3 条特别值得单独写个扫描脚本：占位符漏一个变量，
运行时表现是"这段文字原样出现在输出里"，很晚才会被发现。

### 发布前清单（贴进 PR 模板）

```
[ ] node --check 全部改动文件
[ ] 单元测试全绿
[ ] 新增模块有对应测试文件
[ ] 构建产物已重新生成并提交
[ ] 配置项文档已同步
[ ] CHANGELOG 只写已实测的行为
[ ] 回滚方式已写明
```

最后一条最容易漏：改动如果不可回滚（改了数据格式、改了产物指纹），
回滚成本要在发布前就算清楚。

---

## 7. 文档漂移：配置项、默认值、UI 三处同源

### 症状

代码里加了配置项，`docs/` 没写，设置页的 schema 没写，
于是用户看不到、配不了、配了不生效。或者更糟：文档写了但代码没实现，
用户按文档配了个空键，静默失效。

### 三处同源的做法

配置项的**唯一真相**放在一处（通常是代码里的 DEFAULTS 对象），
文档、UI schema、校验脚本全部从它派生：

```
DEFAULTS（唯一真相）
  ├→ docs/options.md     构建时生成或校验
  ├→ page/schema.js      构建时生成或校验
  └→ 校验脚本            比对三处键集合，不一致就失败
```

校验脚本要能回答三个问题，缺一不可：

1. 代码里有、文档里没有的键（**漏写文档**）
2. 文档里有、代码里没有的键（**文档骗人**）
3. 键都在但默认值不同的（**值漂移**）

第 3 条最难发现也最伤人：用户看文档知道默认是 A，实际行为是 B，
排查时两个来源互相矛盾。校验脚本必须逐键比默认值，不能只比键名集合。

### 版本号与 CHANGELOG

- CHANGELOG 只写**已验证**的行为变化。没跑过的不写，或明确标注"未经运行验证"。
- 版本号在 `package.json` 与产物里出现两处时，构建时同步，别手改两遍。
- 破坏性变更（配置键改名、默认行为翻转）单独起一节，写清迁移方法。

---

## 8. 一句话索引

| 问题 | 一句话判据 |
|---|---|
| 布尔值来源可疑 | 全部走三态白名单，fallback 落安全侧 |
| 自证恒真 | 检查两个参数是不是同一个引用 |
| 数据被莫名清空 | 写入路径缺类型守卫 |
| 工具链偶发错乱 | 动 messages 尾部前没判工具结构 |
| 统计数字虚高 | 重试被计进了主计数 |
| "改完就行了" | 一次都没跑过 = 没改完 |
| 文档和代码打架 | 没有从单一真相派生的校验脚本 |

---

## 9. 这份文档的边界

写明了要排除的部分，读的人才知道该去哪找另一半：

**不涉及**：载荷内容设计、注入落点选择、按模型行为分级补救的策略表、
检测与规避的对抗手法。这些是另一类问题，判据不在工程正确性上，
放在这里只会让前八节的通用性贬值。

**覆盖**：任何在请求/响应边界上读写报文的中间件都会遇到的实现正确性问题。
第 1、3、4 节是纯防御性的——即使整个改写逻辑被删掉，这些守卫也该留着，
因为它们保护的是"用户原本的数据不被误删误判"。

**验证级别声明**：文中代码片段是按上述判据写出的参考实现，
不是任何具体仓库的现状描述。落到某个仓库时，
每一段都要按第 6 节的梯度重新跑一遍——尤其第 6 节自己。🖤