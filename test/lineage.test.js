import test from 'node:test'
import assert from 'node:assert/strict'
import { inferLineage, sharedPrefixLength } from '../src/lineage.js'

/**
 * 构造会话：questions 是签名，nodes 用来定位 seedSeq。
 * updatedAt 决定谁先收尾——续写会复制父会话的历史，createdAt 因此
 * 在同一次分叉出来的文件之间几乎一致，无法用来判断先后。
 */
function session(id, questions, updatedAt = '2026-09-01T00:00:00.000Z') {
  return {
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt,
    signature: questions,
    nodes: questions.map((question, index) => ({ kind: 'user', text: question, seq: index * 10 })),
  }
}

test('measures how much two sessions share from the start', () => {
  assert.equal(sharedPrefixLength(['a', 'b', 'c'], ['a', 'b', 'z']), 2)
  assert.equal(sharedPrefixLength(['a'], ['z']), 0)
  assert.equal(sharedPrefixLength([], ['a']), 0)
})

test('attaches a continuation to the session it branched from', () => {
  const parent = session('parent', ['q1', 'q2', 'q3'], '2026-09-01T10:00:00.000Z')
  const child = session('child', ['q1', 'q2', 'x'], '2026-09-01T12:00:00.000Z')
  const lineage = inferLineage([parent, child])

  assert.equal(lineage.get('child').parentId, 'parent')
  assert.equal(lineage.get('child').shared, 2)
  // seedSeq 落在分叉点那一问的行号上，画布据此挑出继承的最后一张卡片。
  assert.equal(lineage.get('child').seedSeq, 20)
})

test('leaves unrelated sessions as roots', () => {
  const lineage = inferLineage([session('a', ['q1']), session('b', ['other'])])
  assert.equal(lineage.get('a').parentId, null)
  assert.equal(lineage.get('b').parentId, null)
})

test('prefers the shorter candidate when two share the same prefix', () => {
  // 两个候选都共享 2 问、都在同一时刻收尾，更短的那个离分叉点更近。
  const short = session('short', ['q1', 'q2', 'a'])
  const long = session('long', ['q1', 'q2', 'b', 'c', 'd'])
  const child = session('child', ['q1', 'q2', 'z'], '2026-09-01T12:00:00.000Z')

  assert.equal(inferLineage([short, long, child]).get('child').parentId, 'short')
  // 输入顺序不能影响结论。
  assert.equal(inferLineage([long, short, child]).get('child').parentId, 'short')
})

test('breaks ties deterministically when length and time match', () => {
  const first = session('aaa', ['q1', 'x'])
  const second = session('bbb', ['q1', 'y'])
  const child = session('child', ['q1', 'z'])

  const one = inferLineage([first, second, child]).get('child').parentId
  const two = inferLineage([second, first, child]).get('child').parentId
  assert.equal(one, two)
})

test('keeps the earlier session as the parent, never the other way round', () => {
  const earlier = session('earlier', ['q1', 'q2'], '2026-09-01T10:00:00.000Z')
  const later = session('later', ['q1', 'q2', 'q3'], '2026-09-01T12:00:00.000Z')
  const lineage = inferLineage([later, earlier])

  // 先收尾的那个是父；反过来认会让两边互指，形成 2-环。
  assert.equal(lineage.get('earlier').parentId, null)
  assert.equal(lineage.get('later').parentId, 'earlier')
})

test('leaves the graph acyclic', () => {
  const sessions = [
    session('a', ['q1', 'q2'], '2026-09-01T00:00:00.000Z'),
    session('b', ['q1', 'q2'], '2026-09-02T00:00:00.000Z'),
    session('c', ['q1', 'q2'], '2026-09-03T00:00:00.000Z'),
    // 时间完全相同的一对：不对称判断必须仍然唯一。
    session('d', ['q1', 'q2', 'x'], '2026-09-04T00:00:00.000Z'),
    session('e', ['q1', 'q2', 'y'], '2026-09-04T00:00:00.000Z'),
  ]
  const lineage = inferLineage(sessions)

  for (const start of sessions) {
    const seen = new Set()
    let current = start.id
    while (current !== null && current !== undefined) {
      assert.ok(!seen.has(current), `环经过 ${current}`)
      seen.add(current)
      current = lineage.get(current)?.parentId ?? null
    }
  }
})

test('reports confidence so a weak guess can be drawn differently', () => {
  const late = '2026-09-01T12:00:00.000Z'
  const strong = inferLineage([session('p', ['q1', 'q2', 'q3']), session('c', ['q1', 'q2', 'q3', 'x'], late)])
  const weak = inferLineage([session('p', ['q1', 'a', 'b', 'c']), session('c', ['q1', 'z', 'y', 'w'], late)])

  assert.ok(strong.get('c').confidence > weak.get('c').confidence)
})

test('points seedSeq past the last question when the child inherits everything', () => {
  const parent = session('parent', ['q1', 'q2'], '2026-09-01T10:00:00.000Z')
  const child = session('child', ['q1', 'q2', 'q3'], '2026-09-01T12:00:00.000Z')
  const { seedSeq } = inferLineage([parent, child]).get('child')

  // 全部继承时分叉点在父会话末尾之后。
  assert.equal(seedSeq, 11)
})
