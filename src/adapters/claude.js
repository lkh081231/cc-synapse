import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { JsonlReader } from '../jsonl.js'
import { MAX_PROJECTION_LENGTH, PROJECTION_TRUNCATED_SUFFIX, titleFromText } from '../store.js'

const MAX_TITLE_LENGTH = 120
const SIGNATURE_PREFIX = 300

// IDE 注入的上下文壳：闭合标签之后仍是真实的用户提问，必须剥壳保留，
// 整条丢弃会让相当一部分真实提问从画布上消失。
const CONTEXT_SHELLS = ['ide_selection', 'ide_opened_file']
// 这些标签闭合后没有正文，整条都是噪音。
const NOISE_TAGS = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification|system-reminder|ide_diagnostics)\b/

export const claudeAdapter = {
  id: 'claude',
  roots: options => join(options?.claudeDir ?? defaultClaudeDir(), 'projects'),
  discover: discoverSessions,
  parse: parseSession,
}

export function defaultClaudeDir() {
  return join(homedir(), '.claude')
}

/**
 * 列出一个项目目录下的会话文件。
 *
 * 只取顶层 *.jsonl：`<sessionId>/subagents/agent-*.jsonl` 是 Task 工具派生的
 * 子代理记录，不是独立会话，递归扫描会把它们误当成会话。
 */
export async function discoverSessions(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(dir, entry.name))
    .sort()
}

/**
 * 把一个会话文件解析成中立会话模型。
 *
 * 节点粒度：**一个节点 = 一次用户输入 + 它引发的完整回合**。
 * 助手输出只决定节点内容，不决定节点数量——一个回合里常有多条带 text 的
 * assistant 记录（实测最多 76 条），逐条建节点会让画布不可用；而纯工具回合
 * 一条 text 都没有，跳过就会让用户的提问凭空消失。
 *
 * @returns {Promise<object|null>} 没有可见节点时返回 null
 */
export async function parseSession(file, reader = new JsonlReader()) {
  const { records } = await reader.read(file)
  if (records.length === 0) return null

  const session = {
    id: basename(file, '.jsonl'),
    sourceFile: file,
    cwd: null,
    title: null,
    aiTitle: null,
    createdAt: null,
    updatedAt: null,
    nodes: [],
  }

  const state = { current: null, askIds: new Set(), pendingProcess: [] }

  for (const { line, value } of records) {
    if (typeof value !== 'object' || value === null) continue
    applyRecord(session, state, line, value)
  }
  closeNode(session, state)

  if (session.nodes.length === 0) return null
  session.title = sessionTitle(session)
  session.signature = signatureOf(session.nodes)
  return session
}

function applyRecord(session, state, line, record) {
  // cwd 在单个文件里会变（子代理、工具切目录），首条带 cwd 的记录才代表
  // 这个会话真正属于哪个工作区。
  if (session.cwd === null && typeof record.cwd === 'string' && record.cwd !== '') {
    session.cwd = normalizeCwd(record.cwd)
  }
  if (typeof record.timestamp === 'string') {
    session.createdAt ??= record.timestamp
    session.updatedAt = record.timestamp
  }
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') {
    session.aiTitle = record.aiTitle.trim().slice(0, MAX_TITLE_LENGTH)
    return
  }
  if (record.type === 'user') return applyUser(session, state, line, record)
  if (record.type === 'assistant') return applyAssistant(session, state, line, record)
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    closeNode(session, state)
    openNode(session, state, { kind: 'compact', text: '', seq: line, at: record.timestamp })
    closeNode(session, state)
  }
}

function applyUser(session, state, line, record) {
  const content = record.message?.content
  const blocks = Array.isArray(content) ? content : []

  // 工具结果先折叠。AskUserQuestion 的结果是一次真实的用户输入，
  // 它开启新节点；其余工具结果折进当前节点的过程记录。
  for (const block of blocks) {
    if (block?.type !== 'tool_result') continue
    if (state.askIds.has(block.tool_use_id)) {
      closeNode(session, state)
      openNode(session, state, {
        kind: 'user',
        variant: 'ask',
        text: formatAnswers(record.toolUseResult),
        seq: line,
        at: record.timestamp,
      })
      continue
    }
    foldToolResult(session, state, {
      callId: block.tool_use_id,
      result: contentText(block.content),
      error: block.is_error === true ? contentText(block.content) : stderrOf(record.toolUseResult),
    })
  }

  const text = stripContextShells(plainText(content))
  if (isNoiseUser(record, blocks, text)) return
  closeNode(session, state)
  openNode(session, state, { kind: 'user', text, seq: line, at: record.timestamp })
}

function applyAssistant(session, state, line, record) {
  const node = state.current
  const blocks = Array.isArray(record.message?.content) ? record.message.content : []

  if (record.isApiErrorMessage === true || record.error !== undefined) {
    if (node !== null) node.failed = true
  }
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      // 累积而不是新建节点：同一回合的多条 assistant 记录属于同一个节点。
      if (node !== null) {
        node.answer = node.answer === '' ? block.text : `${node.answer}\n\n${block.text}`
        // 助手消息的 seq 必须是真实行号：画布多处用 Number.isInteger 把关
        // （分支按钮、seedLength 比较），小数会让这些判断全部落空。
        node.answerSeq = line
      }
    } else if (block?.type === 'thinking') {
      const text = typeof block.thinking === 'string' ? block.thinking : ''
      if (text.trim() !== '') {
        processOf(state).push({ callId: `thinking:${record.uuid}`, name: '思考', arguments: null, result: text, error: null })
      }
    } else if (block?.type === 'tool_use') {
      if (block.name === 'AskUserQuestion') state.askIds.add(block.id)
      foldToolCall(state, block)
    }
  }
  if (node !== null && typeof record.timestamp === 'string') node.at = record.timestamp
}

function openNode(session, state, init) {
  state.current = {
    kind: init.kind,
    variant: init.variant ?? null,
    text: init.text ?? '',
    answer: '',
    failed: false,
    seq: init.seq,
    answerSeq: null,
    at: init.at ?? null,
    process: state.pendingProcess,
  }
  state.pendingProcess = []
}

function closeNode(session, state) {
  const node = state.current
  state.current = null
  if (node === null) return
  node.text = truncate(node.text)
  node.answer = truncate(node.answer)
  session.nodes.push(node)
}

function processOf(state) {
  // 工具结果可能先于任何节点出现（会话开头的续跑），先挂在待定区，
  // 下一个节点开启时会接手。
  return state.current === null ? state.pendingProcess : state.current.process
}

function foldToolCall(state, block) {
  const bucket = processOf(state)
  const entry = bucket.find(item => item.callId === block.id)
  const args = block.input === undefined ? null : safeJson(block.input)
  if (entry === undefined) {
    bucket.push({ callId: block.id, name: block.name ?? '工具调用', arguments: args, result: null, error: null })
  } else {
    entry.name = block.name ?? entry.name
    entry.arguments = args
  }
}

function foldToolResult(session, state, { callId, result, error }) {
  // tool_use 的 id 全局唯一，所以直接按 id 找，不需要 DSH 那种 (turn, step) 匹配。
  const buckets = [state.pendingProcess]
  if (state.current !== null) buckets.push(state.current.process)
  for (let index = session.nodes.length - 1; index >= 0; index -= 1) buckets.push(session.nodes[index].process)

  for (const bucket of buckets) {
    const entry = bucket?.find(item => item.callId === callId)
    if (entry !== undefined) {
      entry.result = result
      entry.error = error
      return
    }
  }
  processOf(state).push({ callId, name: '工具调用', arguments: null, result, error })
}

function isNoiseUser(record, blocks, text) {
  if (record.isMeta === true) return true
  if (record.isCompactSummary === true) return true
  if (NOISE_TAGS.test(text)) return true
  // 纯工具结果的记录不是用户发言，上面已经折叠过了。
  if (blocks.length > 0 && blocks.every(block => block?.type === 'tool_result')) return true
  return text.trim() === ''
}

/** 剥掉 IDE 注入的上下文壳，保留后面的真实提问。 */
export function stripContextShells(text) {
  let out = text
  for (const tag of CONTEXT_SHELLS) {
    const close = `</${tag}>`
    const index = out.indexOf(close)
    if (index >= 0) out = out.slice(index + close.length).trim()
  }
  return out
}

/** AskUserQuestion 的回答：toolUseResult.answers 已是干净的 {问题: 回答}。 */
export function formatAnswers(toolUseResult) {
  const answers = toolUseResult?.answers
  if (answers === undefined || answers === null || typeof answers !== 'object') return '（已回答）'
  const parts = Object.entries(answers).map(([question, answer]) => `**${question}**\n${answer}`)
  return parts.length === 0 ? '（已回答）' : parts.join('\n\n')
}

function plainText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
    .filter(text => text !== '')
    .join('\n')
}

function stderrOf(toolUseResult) {
  const stderr = toolUseResult?.stderr
  return typeof stderr === 'string' && stderr.trim() !== '' ? stderr : null
}

function sessionTitle(session) {
  if (session.aiTitle !== null) return session.aiTitle
  const first = session.nodes.find(node => node.kind === 'user' && node.text.trim() !== '')
  return first === undefined ? 'Claude 会话' : titleFromText(first.text)
}

/**
 * 分支签名：只取用户输入。
 * 助手回答对同一提问每次都不同，拿它比对会让本该同源的会话判成无关。
 */
export function signatureOf(nodes) {
  return nodes
    .filter(node => node.kind === 'user' && node.text.trim() !== '')
    .map(node => createHash('md5').update(node.text.slice(0, SIGNATURE_PREFIX)).digest('hex').slice(0, 12))
}

/** 盘符大小写与分隔符不一致会让同一个目录分裂成两个工作区。 */
export function normalizeCwd(cwd) {
  const unified = cwd.replace(/\//g, '\\')
  return /^[a-z]:/.test(unified) ? unified[0].toUpperCase() + unified.slice(1) : unified
}

function truncate(text) {
  return text.length > MAX_PROJECTION_LENGTH
    ? text.slice(0, MAX_PROJECTION_LENGTH) + PROJECTION_TRUNCATED_SUFFIX
    : text
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/**
 * 把节点摊平成画布契约要求的 messages。
 *
 * 画布把 user/assistant 配对成卡片，所以一个节点最多摊成两条消息。
 * 两条都用真实行号：`Number.isInteger(sourceSeq)` 在画布里多处把关
 * （分支按钮、seedLength 比较），非整数会让这些判断静默失效。
 */
export function messagesOf(session) {
  return session.nodes.flatMap(node => {
    if (node.kind === 'compact') return []
    const messages = [{ kind: 'user', text: node.text, sourceSeq: node.seq, at: node.at, variant: node.variant }]
    if (node.answer.trim() !== '') {
      messages.push({ kind: 'assistant', text: node.answer, sourceSeq: node.answerSeq ?? node.seq, at: node.at, process: node.process })
    } else if (node.failed) {
      messages.push({ kind: 'error', text: '（本回合未产生回答）', sourceSeq: node.answerSeq ?? node.seq, at: node.at, process: node.process })
    }
    return messages
  })
}
