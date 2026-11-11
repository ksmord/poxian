// 观测：每请求一行 JSONL。失败一律吞掉——观测不许影响请求。
import { appendFile, mkdir, stat, rename } from "node:fs/promises"
import { dirname } from "node:path"
import { expandPath } from "./options.mjs"

const MAX_BYTES = 2 * 1024 * 1024
let chain = Promise.resolve()

export function record(o, ctx, data) {
  if (!o || !o.log) return
  const path = expandPath(o.log_path, ctx)
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      agent: (ctx && ctx.agent) || null,
      model: (ctx && ctx.model) || null,
      ...data,
    }) + "\n"

  chain = chain.then(() => append(path, line, o.log_backup_count)).catch(() => {})
}

async function append(path, line, backups) {
  try {
    await mkdir(dirname(path), { recursive: true })
    try {
      const st = await stat(path)
      if (st.size > MAX_BYTES) await rotate(path, backups)
    } catch {
      // 文件还不存在，正常
    }
    await appendFile(path, line, "utf8")
  } catch {
    // 磁盘满 / 权限错：观测失败不影响主流程
  }
}

// 轮转：.N-1 → .N … .1 → .2，最后 current → .1。
// backups = 1 时与旧版完全一致（只留 .1，直接覆盖）。
async function rotate(path, backups) {
  const n = Math.max(1, Math.min(9, Number(backups) || 1))
  for (let i = n - 1; i >= 1; i--) {
    try {
      await rename(path + "." + i, path + "." + (i + 1))
    } catch {
      // 这一代不存在，跳过
    }
  }
  await rename(path, path + ".1")
}

// 等待队列写完。进程退出前 / 测试里需要确定性时调用。
export function flush() {
  return chain
}
