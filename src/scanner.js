import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonlReader } from './jsonl.js'
import { defaultClaudeDir, discoverSessions, messagesOf, normalizeCwd, parseSession } from './adapters/claude.js'
import { inferLineage } from './lineage.js'

/**
 * 扫描 Claude Code 的会话目录，产出可以直接灌进画布的会话列表。
 *
 * 读取器在多次扫描之间复用，所以只有真正追加过内容的文件会重新解析。
 */
export class Scanner {
  constructor({ claudeDir = defaultClaudeDir(), cwd = null, all = false } = {}) {
    this.projectsDir = join(claudeDir, 'projects')
    this.cwd = cwd === null ? null : normalizeCwd(cwd)
    this.all = all
    this.reader = new JsonlReader()
    this.sessions = new Map()
  }

  /** @returns {Promise<Array>} 按工作区分好组、接好父子关系的会话 */
  async scan() {
    const dirs = await this.projectDirs()
    const seen = new Set()

    for (const dir of dirs) {
      for (const file of await discoverSessions(dir)) {
        // 限定了工作目录时先窥一眼文件头：不属于这个目录的会话根本不必解析。
        // 这是「只扫当前目录」的真正省时之处，全量解析要慢两个数量级。
        if (!this.all && this.cwd !== null && !this.sessions.has(file)) {
          const owner = await peekCwd(file)
          if (owner !== null && owner.toLowerCase() !== this.cwd.toLowerCase()) continue
        }
        seen.add(file)
        // 先用共享的读取器问一句「动过没有」：没动就沿用上次的解析结果，
        // 这是重复扫描几乎不花时间的原因。
        const { unchanged } = await this.reader.read(file).catch(() => ({ unchanged: false }))
        if (unchanged && this.sessions.has(file)) continue

        // 动过就整份重新解析。会话是一条累积的对话，只把新增的几行投影出来
        // 会丢掉前面所有内容——增量只用来判断变化，不用来拼装结果。
        const parsed = await parseSession(file).catch(() => null)
        if (parsed === null) {
          this.sessions.delete(file)
          continue
        }
        this.sessions.set(file, parsed)
      }
    }
    for (const file of this.sessions.keys()) {
      if (!seen.has(file)) this.sessions.delete(file)
    }

    const sessions = [...this.sessions.values()].filter(session => this.matchesCwd(session))
    return this.withLineage(sessions)
  }

  matchesCwd(session) {
    if (this.all || this.cwd === null) return true
    return session.cwd !== null && session.cwd.toLowerCase() === this.cwd.toLowerCase()
  }

  /** 分支关系只在同一个工作区内推断——跨目录的会话不可能是分支。 */
  withLineage(sessions) {
    const byCwd = new Map()
    for (const session of sessions) {
      const key = session.cwd ?? ''
      if (!byCwd.has(key)) byCwd.set(key, [])
      byCwd.get(key).push(session)
    }

    const out = []
    for (const group of byCwd.values()) {
      const lineage = inferLineage(group)
      for (const session of group) {
        const relation = lineage.get(session.id)
        out.push({
          id: session.id,
          cwd: session.cwd,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          sourceFile: session.sourceFile,
          parentId: relation?.parentId ?? null,
          seedSeq: relation?.seedSeq ?? null,
          confidence: relation?.confidence ?? 0,
          messages: messagesOf(session),
        })
      }
    }
    return out
  }

  /**
   * 目录名是 cwd 的有损转写，多个项目可能落进同一个目录名，所以它只用来
   * 缩小搜索范围，最终归属仍以记录里的 cwd 为准。限定了工作目录时，
   * 匹配到候选目录就只看那一个，避免为了判断归属去翻遍所有项目。
   */
  async projectDirs() {
    const entries = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => [])
    const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    if (!this.all && this.cwd !== null) {
      const wanted = slugOf(this.cwd)
      const hit = dirs.filter(name => name.toLowerCase() === wanted)
      if (hit.length > 0) return hit.map(name => join(this.projectsDir, name))
    }
    return dirs.map(name => join(this.projectsDir, name))
  }
}

/**
 * 只读文件开头，取出这个会话属于哪个工作目录。
 *
 * 会话文件可以有几十兆，而 cwd 就在最前面几行，没必要为了判断归属
 * 把整个文件解析一遍。
 */
async function peekCwd(file, bytes = 8192) {
  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return null
  try {
    const buffer = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = JSON.parse(line).cwd
        if (typeof cwd === 'string' && cwd !== '') return normalizeCwd(cwd)
      } catch {
        // 末行可能被截断，继续看下一行。
      }
    }
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Claude Code 存放会话时用的目录名：路径里非字母数字的字符都变成连字符。
 * 这个转写是有损的——`C:\神经网络笔记` 和 `C:\价格计算插件` 会撞成同一个名字，
 * 所以它只能用来缩小范围，不能当作工作区的标识。
 */
export function slugOf(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
}
