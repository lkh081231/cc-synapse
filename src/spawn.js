import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const SESSION_ID = /^[0-9a-fA-F-]{36}$/

/**
 * 在一个新的终端窗口里打开 Claude Code。
 *
 * Claude Code 是终端界面，必须有 tty，所以不能直接 detach 到后台——
 * 得先拉起一个终端再让它接管。参数一律以数组传递、不经过 shell，
 * 这样含空格或中文的路径不会被重新解析。
 */
export async function openClaudeSession({ cwd, sessionId = null, claudeBin = null, platform = process.platform, spawnFn = spawn, lookup = which } = {}) {
  if (typeof cwd !== 'string' || cwd === '') throw Object.assign(new Error('缺少工作目录'), { status: 400 })
  if (sessionId !== null && !SESSION_ID.test(sessionId)) throw Object.assign(new Error('会话标识不合法'), { status: 400 })

  const bin = claudeBin ?? await lookup('claude', platform)
  if (bin === null) throw Object.assign(new Error('找不到 claude 可执行文件'), { status: 500 })

  const args = sessionId === null ? [] : ['--resume', sessionId]
  const [command, commandArgs, spawnCwd] = await launcher({ bin, args, cwd, platform, lookup })

  const child = spawnFn(command, commandArgs, { cwd: spawnCwd, detached: true, stdio: 'ignore' })
  child.unref?.()
  return { command, args: commandArgs }
}

/**
 * 挑一个能开出可见终端窗口的方式。
 * Windows Terminal 优先，它按数组接收参数，路径里的空格不会出问题。
 */
export async function launcher({ bin, args, cwd, platform, lookup = which }) {
  if (platform === 'win32') {
    if (await lookup('wt.exe', platform) !== null) return ['wt.exe', ['-d', cwd, bin, ...args], undefined]
    const conhost = await lookup('conhost.exe', platform)
    if (conhost !== null) return ['conhost.exe', [bin, ...args], cwd]
    // 兜底：start 的第一个引号参数是窗口标题，必须留空，否则路径会被当成标题。
    return ['cmd.exe', ['/c', 'start', '', bin, ...args], cwd]
  }
  if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(`cd ${quote(cwd)} && ${quote(bin)} ${args.map(quote).join(' ')}`)}`
    return ['osascript', ['-e', script], undefined]
  }
  for (const terminal of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    if (await lookup(terminal, platform) !== null) return [terminal, ['-e', bin, ...args], cwd]
  }
  return [bin, args, cwd]
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 在 PATH 上找一个可执行文件。 */
async function which(name, platform = process.platform) {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const suffixes = platform === 'win32' && !/\.\w+$/.test(name) ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of paths) {
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // 换下一个候选
      }
    }
  }
  return null
}
