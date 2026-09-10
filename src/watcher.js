import { watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 盯着 Claude Code 的会话目录，有变化就回调。
 *
 * fs.watch 给的是亚秒级响应，但它在 Windows 上会把同一个文件的连续追加
 * 合并成一次事件，编辑器改用重命名写入时还可能整个漏掉。所以另外挂一个
 * 低频的 stat 巡检兜底——几十次 stat 只要几毫秒，比漏更新划算。
 */
export function watchSessions(root, onChange, { pollMs = 5_000, debounceMs = 300 } = {}) {
  let timer = null
  let closed = false
  const fingerprints = new Map()

  const fire = () => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!closed) onChange()
    }, debounceMs)
  }

  let watcher = null
  try {
    // Linux 的 inotify 不支持递归，那里只能靠巡检。
    watcher = watch(root, { recursive: process.platform !== 'linux' }, (_event, filename) => {
      if (typeof filename !== 'string' || filename.endsWith('.jsonl')) fire()
    })
    watcher.on('error', () => {})
  } catch {
    // 目录还不存在或平台不支持，交给巡检。
  }

  const poll = setInterval(() => {
    void reconcile(root, fingerprints).then(changed => {
      if (changed) fire()
    })
  }, pollMs)
  poll.unref?.()

  // 先记一次基线，免得第一轮巡检把所有文件都当成新变化。
  void reconcile(root, fingerprints)

  return () => {
    closed = true
    clearTimeout(timer)
    clearInterval(poll)
    watcher?.close()
  }
}

/** 比对大小与修改时间，判断这一轮有没有文件真的动过。 */
async function reconcile(root, fingerprints) {
  const files = await sessionFiles(root)
  let changed = false

  for (const file of files) {
    const info = await stat(file).catch(() => null)
    if (info === null) continue
    const mark = `${info.size}:${info.mtimeMs}`
    if (fingerprints.get(file) !== mark) {
      fingerprints.set(file, mark)
      changed = true
    }
  }
  for (const file of fingerprints.keys()) {
    if (!files.includes(file)) {
      fingerprints.delete(file)
      changed = true
    }
  }
  return changed
}

async function sessionFiles(root) {
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const entries = await readdir(join(root, dir.name), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(root, dir.name, entry.name))
    }
  }
  return files
}
