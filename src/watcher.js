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

  const watchers = []
  const observe = (dir, recursive) => {
    try {
      const handle = watch(dir, { recursive }, (_event, filename) => {
        if (typeof filename !== 'string' || filename.endsWith('.jsonl')) fire()
      })
      handle.on('error', () => {})
      watchers.push(handle)
    } catch {
      // 目录不存在或平台不支持，交给巡检。
    }
  }

  observe(root, process.platform !== 'linux')
  // Linux 的 inotify 不支持递归，`watch(root)` 只盯 root 那一层，
  // 子目录里新建会话文件收不到任何事件。这里给每个项目目录单独挂一个，
  // 否则那条腿等于没有——巡检又跟基线有竞态，两条腿一起瞎就是
  // 新会话永远不出现在画布上。
  if (process.platform === 'linux') {
    void readdir(root, { withFileTypes: true })
      .then(entries => {
        for (const entry of entries) {
          if (!closed && entry.isDirectory()) observe(join(root, entry.name), false)
        }
      })
      .catch(() => {})
  }

  const poll = setInterval(() => {
    void reconcile(root, fingerprints).then(changed => {
      if (changed) fire()
    })
  }, pollMs)
  poll.unref?.()

  // 先记一次基线，免得第一轮巡检把所有文件都当成新变化。
  //
  // 基线是异步的，跨过它的新文件会被当成"本来就有"记进 fingerprints，
  // 之后巡检比对"没变"就再也不通知。所以基线**只认扫描开始那一刻**的
  // 目录快照，之后出现的文件一律留给巡检。
  void baseline(root, fingerprints)

  return () => {
    closed = true
    clearTimeout(timer)
    clearInterval(poll)
    for (const handle of watchers) handle.close()
  }
}

/** 记下启动时已有的文件，只认调用瞬间的那份目录快照。 */
async function baseline(root, fingerprints) {
  for (const file of await sessionFiles(root)) {
    const info = await stat(file).catch(() => null)
    if (info === null) continue
    // 巡检可能已经先一步把它当成新文件处理过，别拿基线盖掉那条记录。
    if (!fingerprints.has(file)) fingerprints.set(file, `${info.size}:${info.mtimeMs}`)
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
