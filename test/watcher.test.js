import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchSessions } from '../src/watcher.js'

async function projectRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-synapse-watch-'))
  const root = join(dir, 'projects')
  await mkdir(join(root, 'c--demo'), { recursive: true })
  return root
}

/** 等到条件成立，或者超时放弃。 */
async function until(predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

test('reports an appended session', async () => {
  const root = await projectRoot()
  const file = join(root, 'c--demo', 'aaaaaaaa.jsonl')
  await writeFile(file, '{"type":"user"}\n', 'utf8')

  let changes = 0
  const stop = watchSessions(root, () => { changes += 1 }, { pollMs: 300, debounceMs: 50 })
  try {
    await appendFile(file, '{"type":"assistant"}\n', 'utf8')
    assert.ok(await until(() => changes > 0), '追加内容后应当收到通知')
  } finally {
    stop()
  }
})

test('reports a brand new session file', async () => {
  const root = await projectRoot()

  let changes = 0
  const stop = watchSessions(root, () => { changes += 1 }, { pollMs: 300, debounceMs: 50 })
  try {
    await writeFile(join(root, 'c--demo', 'bbbbbbbb.jsonl'), '{"type":"user"}\n', 'utf8')
    assert.ok(await until(() => changes > 0), '新建会话后应当收到通知')
  } finally {
    stop()
  }
})

test('stays quiet while nothing changes', async () => {
  const root = await projectRoot()
  await writeFile(join(root, 'c--demo', 'aaaaaaaa.jsonl'), '{"type":"user"}\n', 'utf8')

  let changes = 0
  const stop = watchSessions(root, () => { changes += 1 }, { pollMs: 150, debounceMs: 50 })
  try {
    await new Promise(resolve => setTimeout(resolve, 700))
    // 巡检本身不该制造变化，否则画布会无谓地反复重扫。
    assert.equal(changes, 0)
  } finally {
    stop()
  }
})

test('goes silent once stopped', async () => {
  const root = await projectRoot()
  const file = join(root, 'c--demo', 'aaaaaaaa.jsonl')
  await writeFile(file, '{"type":"user"}\n', 'utf8')

  let changes = 0
  const stop = watchSessions(root, () => { changes += 1 }, { pollMs: 150, debounceMs: 50 })
  stop()

  await appendFile(file, '{"type":"assistant"}\n', 'utf8')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(changes, 0)
})

test('survives a directory that does not exist yet', async () => {
  const stop = watchSessions(join(tmpdir(), 'cc-synapse-absent-root'), () => {}, { pollMs: 200 })
  await new Promise(resolve => setTimeout(resolve, 300))
  stop()
})
