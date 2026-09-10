import test from 'node:test'
import assert from 'node:assert/strict'
import { launcher, openClaudeSession } from '../src/spawn.js'

const found = name => async candidate => (candidate === name ? `C:\\bin\\${candidate}` : null)
const never = async () => null

/** 记录调用而不真的起进程。 */
function recorder() {
  const calls = []
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options })
    return { unref() {} }
  }
  return { calls, spawnFn }
}

test('prefers Windows Terminal and passes arguments as an array', async () => {
  const [command, args] = await launcher({
    bin: 'C:\\bin\\claude.exe',
    args: ['--resume', 'abc'],
    cwd: 'C:\\java learning',
    platform: 'win32',
    lookup: found('wt.exe'),
  })

  assert.equal(command, 'wt.exe')
  // 含空格的路径必须原样作为一个参数传过去，不能经 shell 重新解析。
  assert.deepEqual(args, ['-d', 'C:\\java learning', 'C:\\bin\\claude.exe', '--resume', 'abc'])
})

test('falls back through conhost to cmd start', async () => {
  const viaConhost = await launcher({
    bin: 'claude.exe', args: [], cwd: 'C:\\x', platform: 'win32', lookup: found('conhost.exe'),
  })
  assert.equal(viaConhost[0], 'conhost.exe')
  assert.equal(viaConhost[2], 'C:\\x')

  const viaCmd = await launcher({ bin: 'claude.exe', args: [], cwd: 'C:\\x', platform: 'win32', lookup: never })
  assert.equal(viaCmd[0], 'cmd.exe')
  // start 的第一个引号参数是窗口标题，留空才不会把命令吞成标题。
  assert.deepEqual(viaCmd[1].slice(0, 3), ['/c', 'start', ''])
})

test('opens a terminal on macOS through osascript', async () => {
  const [command, args] = await launcher({
    bin: '/usr/local/bin/claude', args: ['--resume', 'x'], cwd: '/tmp/p', platform: 'darwin', lookup: never,
  })
  assert.equal(command, 'osascript')
  assert.equal(args[0], '-e')
  assert.match(args[1], /Terminal/)
})

test('resumes a session by id', async () => {
  const { calls, spawnFn } = recorder()
  await openClaudeSession({
    cwd: 'C:\\demo',
    sessionId: '489e1b8b-3332-4638-b0ec-df3583eda898',
    claudeBin: 'C:\\bin\\claude.exe',
    platform: 'win32',
    spawnFn,
    lookup: found('wt.exe'),
  })

  assert.equal(calls.length, 1)
  assert.ok(calls[0].args.includes('--resume'))
  assert.ok(calls[0].args.includes('489e1b8b-3332-4638-b0ec-df3583eda898'))
})

test('starts a fresh session when no id is given', async () => {
  const { calls, spawnFn } = recorder()
  await openClaudeSession({
    cwd: 'C:\\demo', claudeBin: 'C:\\bin\\claude.exe', platform: 'win32', spawnFn, lookup: found('wt.exe'),
  })
  assert.ok(!calls[0].args.includes('--resume'))
})

test('refuses a malformed session id', async () => {
  const { spawnFn } = recorder()
  await assert.rejects(
    () => openClaudeSession({ cwd: 'C:\\demo', sessionId: '../../evil', claudeBin: 'x', platform: 'win32', spawnFn }),
    /会话标识不合法/,
  )
})

test('refuses to run without a working directory', async () => {
  const { spawnFn } = recorder()
  await assert.rejects(
    () => openClaudeSession({ cwd: '', claudeBin: 'x', platform: 'win32', spawnFn }),
    /缺少工作目录/,
  )
})

test('reports a missing claude executable', async () => {
  const { spawnFn } = recorder()
  await assert.rejects(
    () => openClaudeSession({ cwd: 'C:\\demo', platform: 'win32', spawnFn, lookup: never }),
    /找不到 claude/,
  )
})
