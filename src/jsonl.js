import { open, stat } from 'node:fs/promises'

/**
 * 增量 JSONL 读取器。
 *
 * Claude Code 的会话文件是纯追加写，所以已写入行的行号永不改变——
 * 这正是把行号当作 sourceSeq 的前提（见 docs/architecture.md）。
 * 本类维护每个文件的 offset，只读新增字节。
 *
 * 必须处理的边界：CC 正在写入时，尾部可能是半行（不以 \n 结尾）。
 * 半行不计入行号，暂存到下次读取时前置拼接，否则行号会错乱，
 * 进而让画布上所有卡片 id 漂移。
 */
export class JsonlReader {
  constructor() {
    /** @type {Map<string, {size:number, mtimeMs:number, lineCount:number, tail:Buffer}>} */
    this.cache = new Map()
  }

  forget(file) {
    this.cache.delete(file)
  }

  /**
   * 读取文件中尚未读过的行。
   * @returns {Promise<{records: Array<{line:number, value:object}>, reset:boolean, unchanged:boolean}>}
   *   reset=true 表示文件被重写（缩短），调用方需丢弃既有解析结果。
   */
  async read(file) {
    let info
    try {
      info = await stat(file)
    } catch {
      this.cache.delete(file)
      return { records: [], reset: true, unchanged: false }
    }

    const cached = this.cache.get(file)
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return { records: [], reset: false, unchanged: true }
    }

    // 文件缩短 = 被重写而非追加，既有行号不再可信，全量重读。
    const reset = cached === undefined || info.size < cached.size
    const from = reset ? 0 : cached.size
    const carry = reset ? EMPTY : cached.tail
    let lineNo = reset ? 0 : cached.lineCount

    const chunk = await readFrom(file, from, info.size - from)
    const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])

    // 在字节层面按换行符切分：尾部半行原样留到下次，避免劈开多字节字符。
    const parts = []
    let start = 0
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== NEWLINE) continue
      parts.push(buffer.subarray(start, i))
      start = i + 1
    }
    const tail = buffer.subarray(start)

    const records = []
    for (const part of parts) {
      const line = lineNo++
      const trimmed = part.toString('utf8').trim()
      if (trimmed === '') continue
      // 宽容解析：CC 的格式没有版本承诺，坏行跳过而不是让整个会话失败。
      try {
        records.push({ line, value: JSON.parse(trimmed) })
      } catch {
        // 忽略
      }
    }

    this.cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, lineCount: lineNo, tail })
    return { records, reset, unchanged: false }
  }
}

const NEWLINE = 0x0a
const EMPTY = Buffer.alloc(0)

async function readFrom(file, position, length) {
  if (length <= 0) return EMPTY
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
