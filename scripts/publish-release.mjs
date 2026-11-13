#!/usr/bin/env node
// 发布守则的机器化：版本号一变，Releases 必须跟着变。
// 用法：GITHUB_TOKEN=xxx npm run release
//       npm run release -- --draft        存为草稿
//       npm run release -- --notes-only   只更新 Release 正文，不动 tag（补发历史版本用）
//       POXIAN_VERSION=0.2.4 npm run release -- --notes-only
//
// 四步：
//   1. 读 package.json version（或 POXIAN_VERSION）与 CHANGELOG 里该版本的段落
//   2. 本地 tag 不存在就建 annotated tag
//   3. tag 推到 origin
//   4. Release 不存在就用该 tag 建；已存在则只更新标题与正文

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
const version = process.env.POXIAN_VERSION || pkg.version
const tag = `v${version}`
const repoUrl = (pkg.repository && pkg.repository.url) || ""
const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
if (!m) die(`package.json repository.url 里找不到 GitHub 仓库: ${repoUrl}`)
const [, owner, repo] = m

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
if (!token) die("缺少 GITHUB_TOKEN")

const args = process.argv.slice(2)
const draft = args.includes("--draft")
const notesOnly = args.includes("--notes-only")

const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")
const section = pickSection(changelog, version)
if (!section) die(`CHANGELOG.md 里没有 ${version} 的段落，先补条目再发`)

const title = `${version} · ${section.title}`
const prev = prevVersion(changelog, version)
const body = [
  section.body,
  "",
  "---",
  "",
  prev ? `完整对比：https://github.com/${owner}/${repo}/compare/v${prev}...${tag}` : "",
  `更新日志：https://github.com/${owner}/${repo}/blob/main/CHANGELOG.md`,
]
  .filter(Boolean)
  .join("\n")

function git(...a) {
  return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim()
}

if (!notesOnly) {
  let hasTag = true
  try {
    git("rev-parse", "-q", "--verify", `refs/tags/${tag}`)
  } catch {
    hasTag = false
  }
  if (!hasTag) {
    git("tag", "-a", tag, "-m", `poxian ${version}`)
    console.log(`✓ 建 tag ${tag}`)
  }
  git("push", "origin", tag)
  console.log(`✓ tag ${tag} 已推送`)
}

async function api(method, url, payload, allow404 = false) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "poxian-release",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  if (res.status === 404 && allow404) return null
  if (!res.ok) die(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const existing = await api("GET", `/repos/${owner}/${repo}/releases/tags/${tag}`, undefined, true)
if (existing && existing.id) {
  const updated = await api("PATCH", `/repos/${owner}/${repo}/releases/${existing.id}`, {
    name: title,
    body,
    draft,
    prerelease: false,
  })
  console.log(`✓ 已有 Release，已更新: ${updated.html_url}`)
} else {
  const created = await api("POST", `/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    target_commitish: "main",
    name: title,
    body,
    draft,
    prerelease: false,
  })
  console.log(`✓ 建 Release: ${created.html_url}`)
}

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

// 取 CHANGELOG 中该版本的段落：标题里的 "·" 之后作 Release 标题，正文原样。
function pickSection(md, v) {
  const lines = md.split(/\r?\n/)
  const head = new RegExp(`^##\\s+${v.replace(/\./g, "\\.")}(?:\\s|$)`)
  const start = lines.findIndex((l) => head.test(l))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i
      break
    }
  }
  const heading = lines[start].replace(/^##\s+/, "")
  const title = heading.includes("·") ? heading.split("·").slice(1).join("·").trim() : heading.trim()
  return { title, body: lines.slice(start + 1, end).join("\n").trim() }
}

function prevVersion(md, v) {
  const all = [...md.matchAll(/^##\s+(\d+\.\d+\.\d+)/gm)].map((x) => x[1])
  const i = all.indexOf(v)
  return i > 0 ? all[i - 1] : ""
}
