#!/usr/bin/env node
// 发布守则的机器化：版本号一变，Releases 必须跟着变。
// 用法：GITHUB_TOKEN=xxx npm run release [-- --draft]
//
// 做四件事：
//   1. 读 package.json version 与 CHANGELOG 里该版本的段落
//   2. 本地 tag 不存在就建（annotated）
//   3. tag 推到 origin
//   4. Release 不存在就用 tag 建一个，标题 "0.2.5 · <首行>"
// 已存在的 Release 只更新正文，不重复创建。

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
const version = pkg.version
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

// ── CHANGELOG 段落 ────────────────────────────────────────────────
const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")
const section = pickSection(changelog, version)
if (!section) die(`CHANGELOG.md 里没有 ${version} 的段落，先补条目再发`)

const title = `${version} · ${firstLine(section)}`
const body = `${section}\n\n---\n\n完整对比：https://github.com/${owner}/${repo}/compare/v${prevVersion(changelog, version) || "0.0.0"}...${tag}\n更新日志：https://github.com/${owner}/${repo}/blob/main/CHANGELOG.md`

// ── git ──────────────────────────────────────────────────────────
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

// ── GitHub API ───────────────────────────────────────────────────
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
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (res.status === 404 && allow404) return null
  if (!res.ok) die(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`)
  return data
}

const existing = await api("GET", `/repos/${owner}/${repo}/releases/tags/${tag}`, undefined, true)
if (existing && existing.id) {
  const updated = await api("PATCH", `/repos/${owner}/${repo}/releases/${existing.id}`, {
    name: title,
    body,
    draft,
    prerelease: false,
  })
  console.log(`✓ 已有 Release，正文已更新: ${updated.html_url}`)
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

// ── helpers ──────────────────────────────────────────────────────
function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function pickSection(md, v) {
  const lines = md.split(/\r?\n/)
  const head = new RegExp(`^##\\s+${v.replace(/\./g, "\\.")}(?:\\s|$)`)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return ""
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim()
}

function firstLine(section) {
  const line = section
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("```") && !s.startsWith("|") && !s.startsWith(">"))
  if (!line) return "更新"
  return line
    .replace(/^[#>*\-\s]+/, "")
    .replace(/[`*_]/g, "")
    .slice(0, 60)
}

function prevVersion(md, v) {
  const re = /^##\s+(\d+\.\d+\.\d+)/gm
  const all = [...md.matchAll(re)].map((x) => x[1])
  const i = all.indexOf(v)
  return i > 0 ? all[i - 1] : ""
}
