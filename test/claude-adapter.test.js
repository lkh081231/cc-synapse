import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  discoverSessions,
  formatAnswers,
  normalizeCwd,
  parseSession,
  signatureOf,
  stripContextShells,
} from '../src/adapters/claude.js'

const projects = fileURLToPath(new URL('./fixtures/claude/projects/', import.meta.url))
const demo = join(projects, 'c--demo')
const parse = name => parseSession(join(demo, name))

const FIXTURES = {
  manyText: 'many-text-0000-4000-8000-000000000001.jsonl',
  toolOnly: 'tool-only-0000-4000-8000-000000000002.jsonl',
  ask: 'ask-0000-4000-8000-000000000003.jsonl',
  noise: 'noise-0000-4000-8000-000000000004.jsonl',
  compact: 'compact-0000-4000-8000-000000000005.jsonl',
  attachment: 'attach-0000-4000-8000-000000000006.jsonl',
  empty: 'empty-0000-4000-8000-000000000007.jsonl',
  title: 'title-0000-4000-8000-000000000008.jsonl',
}

// 节点粒度：一个节点 = 一次用户输入 + 它引发的完整回合。
// 下面三个用例守的都是实测发现的真实缺陷，回归价值最高。

test('folds a turn with many assistant text records into a single node', async () => {
  const session = await parse(FIXTURES.manyText)
  assert.equal(session.nodes.length, 1)
  const [node] = session.nodes
  assert.equal(node.text, '把这个重构一下')
  // 12 条 text 全部累积进同一个节点，而不是产生 12 张卡片。
  assert.match(node.answer, /步骤 1/)
  assert.match(node.answer, /步骤 12/)
  assert.equal(node.process.length, 12)
})

test('keeps a node for a turn that produced no assistant text', async () => {
  const session = await parse(FIXTURES.toolOnly)
  assert.equal(session.nodes.length, 1)
  const [node] = session.nodes
  assert.equal(node.text, '跑一下测试')
  assert.equal(node.answer, '')
  assert.equal(node.process.length, 1)
  assert.equal(node.process[0].name, 'Bash')
  assert.equal(node.process[0].result, '61 passing')
})

test('opens a node for an AskUserQuestion answer and reads toolUseResult.answers', async () => {
  const session = await parse(FIXTURES.ask)
  assert.equal(session.nodes.length, 2)
  const [question, answer] = session.nodes
  assert.equal(question.text, '该用哪种方案')
  assert.equal(answer.variant, 'ask')
  // 正文取自结构化的 answers，而不是那段包了英文说明的 tool_result 文本。
  assert.match(answer.text, /方案 A/)
  assert.doesNotMatch(answer.text, /The user answered/)
  assert.equal(answer.answer, '好的，按方案 A 来')
})

test('strips IDE context shells but drops tag-only noise', async () => {
  const session = await parse(FIXTURES.noise)
  assert.equal(session.nodes.length, 1)
  // 剥壳后保留真实提问；整条丢弃会让这类提问从画布上消失。
  assert.equal(session.nodes[0].text, '写成矩阵形式')
})

test('marks the compact boundary and skips the compact summary', async () => {
  const session = await parse(FIXTURES.compact)
  assert.deepEqual(session.nodes.map(node => node.kind), ['user', 'compact', 'user'])
  assert.deepEqual(
    session.nodes.filter(node => node.kind === 'user').map(node => node.text),
    ['第一问', '第二问'],
  )
})

test('projects records whose parent is a non-conversation type', async () => {
  const session = await parse(FIXTURES.attachment)
  assert.equal(session.nodes.length, 1)
  assert.equal(session.nodes[0].text, '看看这个附件')
})

test('returns null for a session without visible nodes', async () => {
  assert.equal(await parse(FIXTURES.empty), null)
})

test('prefers the ai-title record over the first question', async () => {
  const session = await parse(FIXTURES.title)
  assert.equal(session.title, '精炼的标题')
})

test('uses the line number as the node seq', async () => {
  const session = await parse(FIXTURES.compact)
  const seqs = session.nodes.map(node => node.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.ok(seqs.every(Number.isInteger))
})

test('discovers only top-level session files', async () => {
  const files = await discoverSessions(demo)
  assert.equal(files.length, Object.keys(FIXTURES).length)
  // subagents/agent-*.jsonl 是 Task 派生的子代理记录，不是独立会话。
  assert.ok(files.every(file => !file.includes('subagents')))
})

test('groups sessions by cwd rather than by the lossy directory slug', async () => {
  const dir = join(projects, 'c--------')
  const files = await discoverSessions(dir)
  const sessions = await Promise.all(files.map(file => parseSession(file)))
  const cwds = new Set(sessions.map(session => session.cwd))
  assert.equal(cwds.size, 2)
})

test('normalizes drive letter case and separators', () => {
  assert.equal(normalizeCwd('c:\\che_note'), 'C:\\che_note')
  assert.equal(normalizeCwd('c:/che_note'), 'C:\\che_note')
  assert.equal(normalizeCwd('/home/x'), '\\home\\x')
})

test('signs a session from user input only', () => {
  const nodes = [
    { kind: 'user', text: '甲' },
    { kind: 'user', text: '乙' },
    { kind: 'compact', text: '' },
  ]
  const signature = signatureOf(nodes)
  assert.equal(signature.length, 2)
  // 助手回答每次都不同，签名必须只依赖用户输入才稳定。
  assert.deepEqual(signature, signatureOf([...nodes, { kind: 'assistant', text: '答' }]))
})

test('falls back when an answer payload is missing', () => {
  assert.equal(formatAnswers(undefined), '（已回答）')
  assert.equal(formatAnswers({ answers: {} }), '（已回答）')
})

test('leaves plain text untouched when there is no context shell', () => {
  assert.equal(stripContextShells('普通提问'), '普通提问')
})
