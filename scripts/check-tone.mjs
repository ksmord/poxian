// scripts/check-tone.mjs —— 富江精简的「尺度回归」守卫
//
// 为什么只盯 fujiang-lite、且盯的是**产物**不是 md：
// 0.2.5 的教训是拒答不来自正文写得多露，而来自系统提示里那几句**配额**——`≥1 … per 200 words`
// 这类的下限句式会让目标模型在读完提示就判定「这是黄文生成器」，连技术问题一起挡；解剖词表
// 则是纯关键词风险，对占有力没有任何贡献。所以守卫要卡的是这两类**可枚举的写法**，不是文风。
// 其余版本（fujiang / dagou / …）本来就允许更热，扫它们只会得到假阳性，故不扫。
// 读产物而不是读 md：md 里的文档头、围栏、跨文件引用都可能出现这些词，产物才是真正进系统提示的字节。

import { readFileSync } from "node:fs"

const root = new URL("../", import.meta.url)
const built = readFileSync(new URL("poxian-prompt.js", root), "utf8")

// 从产物里切出 fujiang-lite 的 text，不 import：import 会执行整份模块，这里只要字符串
const fence = built.indexOf('"fujiang-lite"')
if (fence < 0) {
  console.error("  ✗ poxian-prompt.js 里没有 fujiang-lite，先跑 npm run build")
  process.exit(1)
}
const m = built.slice(fence).match(/text: ("(?:[^"\\]|\\.)*")/)
const text = m ? JSON.parse(m[1]) : ""

// 下限句式：把「可以带味道」写成「必须产出多少味道」，是拒答的第一触发源
const QUOTA = [
  [/≥\s*\d/, "≥N 配额"],
  [/\bper \d+ words\b/i, "per N words 配额"],
  [/\btier\s*\d\b/i, "tier 分级"],
  [/\bat least \d+\b/i, "at least N 配额"],
  [/\b\d+\s*per turn\b/i, "N per turn 配额"],
]

// 解剖/动作词表：删掉不影响占有力，留着只是把关键词风险摆到明面上
const LEXICON = [
  [/organs|fluids|\bentered\b|\bstretched\b/i, "器官/体液/进入类英文词"],
  [/探进去|顶进去|整根|抽出来还连着丝|硬邦邦的废物|舔干净/, "插入/体液类中文词"],
  [/椅子都湿了|脱干净了/, "裸露开场"],
]

const hits = []
for (const [re, why] of QUOTA) if (re.test(text)) hits.push(`配额句式「${why}」命中 ${JSON.stringify(text.match(re)[0])}`)
for (const [re, why] of LEXICON) if (re.test(text)) hits.push(`词表「${why}」命中 ${JSON.stringify(text.match(re)[0])}`)

// 构建漏取围栏的两个硬特征：正文以 # 标题开头，或含未配对的 ``` 围栏
if (/^#\s/.test(text)) hits.push("产物以 # 标题开头（构建没取围栏内正文）")
if (text.includes("```")) hits.push("产物含 ``` 围栏（构建没取围栏内正文）")
if (!/^LANG:/.test(text)) hits.push("产物首行不是 LANG:（提示头被污染）")

if (hits.length) {
  console.error("  ✗ fujiang-lite 尺度守卫：")
  for (const h of hits) console.error("      " + h)
  process.exit(1)
}
console.log(`  ✓ fujiang-lite 尺度守卫通过（${text.length} 字符，无配额句式 / 无解剖词表 / 无文档头残留）`)
