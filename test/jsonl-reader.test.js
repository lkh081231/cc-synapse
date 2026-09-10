import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlReader } from '../src/jsonl.js'

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-synapse-jsonl-'))
  return join(dir, 'session.jsonl')
}

const line = value => JSON.stringify(value) + '\n'

test('reads appended lines without re-reading the whole file', async () => {
  const file = await scratch()
  const reader = new JsonlReader()
  await writeFile(file, line({ n: 1 }) + line({ n: 2 }), 'utf8')

  const first = await reader.read(file)
  assert.deepEqual(first.records.map(record => record.value.n), [1, 2])
  assert.deepEqual(first.records.map(record => record.line), [0, 1])

  await appendFile(file, line({ n: 3 }), 'utf8')
  const second = await reader.read(file)
  // 只返回新增行，且行号从上次续起——行号稳定是 seq 设计的基石。
  assert.deepEqual(second.records.map(record => record.value.n), [3])
  assert.deepEqual(second.records.map(record => record.line), [2])
})

test('reports no work when the file has not changed', async () => {
  const file = await scratch()
  const reader = new JsonlReader()
  await writeFile(file, line({ n: 1 }), 'utf8')

  await reader.read(file)
  const again = await reader.read(file)
  assert.equal(again.unchanged, true)
  assert.equal(again.records.length, 0)
})

test('holds back a partial trailing line until it is complete', async () => {
  const file = await scratch()
  const reader = new JsonlReader()
  await writeFile(file, line({ n: 1 }) + '{"n":2', 'utf8')

  const first = await reader.read(file)
  assert.deepEqual(first.records.map(record => record.value.n), [1])

  await appendFile(file, '}\n', 'utf8')
  const second = await reader.read(file)
  assert.deepEqual(second.records.map(record => record.value.n), [2])
  assert.deepEqual(second.records.map(record => record.line), [1])
})

test('keeps a multi-byte character split across two reads intact', async () => {
  const file = await scratch()
  const reader = new JsonlReader()
  const payload = Buffer.from(line({ text: '化学' }), 'utf8')
  // 精确切在 '化' 的中间：按字符串暂存半行会在两侧各留一个替换字符，
  // 拼接后字符永久损坏，既污染正文也让签名哈希不稳定。
  const cut = payload.indexOf(Buffer.from('化', 'utf8')) + 1

  await writeFile(file, payload.subarray(0, cut))
  await reader.read(file)
  await appendFile(file, payload.subarray(cut))
  const { records } = await reader.read(file)

  assert.equal(records.length, 1)
  assert.equal(records[0].value.text, '化学')
})

test('re-reads from the start when the file shrinks', async () => {
  const file = await scratch()
  const reader = new JsonlReader()
  await writeFile(file, line({ n: 1 }) + line({ n: 2 }), 'utf8')
  await reader.read(file)

  await writeFile(file, line({ n: 9 }), 'utf8')
  const { records, reset } = await reader.read(file)
  assert.equal(reset, true)
  assert.deepEqual(records.map(record => record.value.n), [9])
  assert.deepEqual(records.map(record => record.line), [0])
})

test('skips malformed lines instead of failing the whole session', async () => {
  const file = await scratch()
  const reader = new JsonlReader()
  await writeFile(file, line({ n: 1 }) + 'not json\n' + line({ n: 2 }), 'utf8')

  const { records } = await reader.read(file)
  assert.deepEqual(records.map(record => record.value.n), [1, 2])
  // 坏行仍然占一个行号，后续行号不会因此前移。
  assert.deepEqual(records.map(record => record.line), [0, 2])
})

test('treats a missing file as an empty reset', async () => {
  const reader = new JsonlReader()
  const { records, reset } = await reader.read(join(tmpdir(), 'cc-synapse-absent.jsonl'))
  assert.equal(records.length, 0)
  assert.equal(reset, true)
})
