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

  let scanning = false
  const poll = setInterval(() => {
    // 上一轮还没扫完就跳过：慢盘上两轮重叠会互相覆盖 fingerprints。
    if (scanning) return
    scanning = true
    void reconcile(root, fingerprints)
      .then(changed => { if (changed) fire() })
      .finally(() => { scanning = false })
  }, pollMs)
  poll.unref?.()

  // 先记一次基线，免得第一轮巡检把所有文件都当成新变化。
  void baseline(root, fingerprints)

  return () => {
    closed = true
    clearTimeout(timer)
    clearInterval(poll)
    watcher?.close()
  }
}

/**
 * 记下启动那一刻已经存在的文件，免得第一轮巡检把它们全当成新变化。
 *
 * 不能直接复用 reconcile：它是"列目录 + 逐个 stat"，整个过程是异步的，
 * 在它跑完之前新建的文件会被一并记进 fingerprints，之后巡检比对发现
 * "没变"，于是**永远不通知**。Linux 上 fs.watch 不支持 recursive、收不到
 * 子目录事件，巡检是唯一的腿，漏了就是新会话不出现在画布上。
 *
 * 所以先取一次目录快照划定时间界线，只给快照里的文件写基线指纹；
 * 快照之后新建的文件不在这张名单上，留给巡检去发现。
 */
async function baseline(root, fingerprints) {
  const snapshot = await sessionFiles(root)
  for (const file of snapshot) {
    const info = await stat(file).catch(() => null)
    if (info === null) continue
    // 巡检可能已经先一步把某个文件当成新文件处理过了，别用基线盖掉它。
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
