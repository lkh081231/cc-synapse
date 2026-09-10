import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'
import { messagesOf, parseSession } from '../src/adapters/claude.js'

const demo = fileURLToPath(new URL('./fixtures/claude/projects/c--demo/', import.meta.url))

/**
 * 画布的 conversationCards 必须能原样吃下 adapter 的产物。
 * 这是本次移植的核心赌注：`sourceSeq` 用真实行号，让画布层零改动。
 * 下面用与 conversation-cards.test.js 相同的 vm 切片方式加载，
 * 断言的是「adapter 产物 → 画布卡片」这条接缝，而不是画布内部行为。
 */
async function loadConversationCards() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('function overlapsCard')
  const end = source.indexOf('function canvasConnectors')
  const context = {
    globalThis: {},
    CARD_WIDTH: 310,
    CARD_HEIGHT: 276,
    CARD_GAP_Y: 42,
    CAMERA_INSET_X: 56,
    CAMERA_INSET_Y: 56,
    messagesFor: thread => thread.messages,
    state: { branchAnchors: new Map(), cardPositions: new Map(), liveReplies: new Map(), collapsedCardIds: new Set() },
  }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.conversationCards = conversationCards`, context)
  return context.globalThis.conversationCards
}

const threadOf = session => ({ id: session.id, parentId: null, position: { x: 86, y: 82 }, messages: messagesOf(session) })

test('turns each node into exactly one canvas card', async () => {
  const conversationCards = await loadConversationCards()
  const session = await parseSession(join(demo, 'many-text-0000-4000-8000-000000000001.jsonl'))
  const cards = conversationCards([threadOf(session)])

  // 12 条带 text 的助手记录必须收敛成一张卡片，而不是 12 张。
  assert.equal(cards.length, 1)
  assert.equal(cards[0].question, '把这个重构一下')
})

test('keeps every projected seq an integer so branch affordances survive', async () => {
  const conversationCards = await loadConversationCards()
  const session = await parseSession(join(demo, 'ask-0000-4000-8000-000000000003.jsonl'))
  const messages = messagesOf(session)

  // 画布多处用 Number.isInteger 把关；非整数会让分支按钮和
  // seedLength 比较静默失效，而不是报错。
  assert.ok(messages.every(message => Number.isInteger(message.sourceSeq)))
  const cards = conversationCards([threadOf(session)])
  assert.ok(cards.some(card => Number.isInteger(card.answer?.sourceSeq)))
})

test('chains cards through parentId in node order', async () => {
  const conversationCards = await loadConversationCards()
  const session = await parseSession(join(demo, 'compact-0000-4000-8000-000000000005.jsonl'))
  const cards = conversationCards([threadOf(session)])

  assert.equal(cards.length, 2)
  assert.equal(cards[0].parentId, null)
  assert.equal(cards[1].parentId, cards[0].id)
})

test('still renders a card for a turn that produced no answer', async () => {
  const conversationCards = await loadConversationCards()
  const session = await parseSession(join(demo, 'tool-only-0000-4000-8000-000000000002.jsonl'))
  const cards = conversationCards([threadOf(session)])

  assert.equal(cards.length, 1)
  assert.equal(cards[0].question, '跑一下测试')
})
