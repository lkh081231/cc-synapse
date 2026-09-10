import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Scanner, slugOf } from '../src/scanner.js'

const claudeDir = fileURLToPath(new URL('./fixtures/claude/', import.meta.url))

test('derives the directory name Claude Code stores a project under', () => {
  assert.equal(slugOf('C:\\che_note'), 'c--che-note')
  assert.equal(slugOf('C:\\java learning\\JavaPark'), 'c--java-learning-javapark')
  // 有损：两个不同项目会撞成同一个名字，所以它只能用来缩小范围。
  assert.equal(slugOf('C:\\神经网络笔记'), slugOf('C:\\价格计算插件'))
})

test('collects every session when scanning across projects', async () => {
  const sessions = await new Scanner({ claudeDir, all: true }).scan()
  const ids = sessions.map(session => session.id)

  assert.ok(ids.length >= 8)
  // Task 派生的子代理记录不是会话。
  assert.ok(sessions.every(session => !session.sourceFile.includes('subagents')))
  // 没有可见节点的会话不该出现在画布上。
  assert.ok(!ids.some(id => id.startsWith('empty-')))
})

test('scopes a scan to one working directory', async () => {
  const sessions = await new Scanner({ claudeDir, cwd: 'c:\\demo' }).scan()

  assert.ok(sessions.length > 0)
  assert.ok(sessions.every(session => session.cwd === 'C:\\demo'))
})

test('separates projects that share a directory name', async () => {
  const first = await new Scanner({ claudeDir, cwd: 'C:\\项目甲' }).scan()
  const second = await new Scanner({ claudeDir, cwd: 'C:\\项目乙' }).scan()

  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.notEqual(first[0].id, second[0].id)
})

test('reuses parsed sessions when nothing changed on disk', async () => {
  const scanner = new Scanner({ claudeDir, all: true })
  const first = await scanner.scan()
  const second = await scanner.scan()

  assert.equal(second.length, first.length)
  // 增量重扫不能丢内容——读取器只返回新增行，缓存必须接住其余部分。
  assert.deepEqual(
    second.map(session => session.messages.length),
    first.map(session => session.messages.length),
  )
})

test('carries lineage and canvas-ready messages on each session', async () => {
  const sessions = await new Scanner({ claudeDir, all: true }).scan()

  for (const session of sessions) {
    assert.ok(Array.isArray(session.messages))
    assert.ok(session.messages.every(message => Number.isInteger(message.sourceSeq)))
    assert.ok(session.parentId === null || typeof session.parentId === 'string')
  }
})
