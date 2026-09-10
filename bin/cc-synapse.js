#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startServer } from '../src/server.js'
import { defaultClaudeDir } from '../src/adapters/claude.js'

const HELP = `cc-synapse —— Claude Code 会话地图

用法: cc-synapse [选项]

  --port <n>          监听端口（默认自动选择）
  --host <h>          监听地址（默认 127.0.0.1）
  --cwd <path>        要查看的项目目录（默认当前目录）
  --all               显示全部项目，而不只是当前目录
  --claude-dir <p>    Claude Code 的数据目录（默认 ~/.claude）
  --data-file <p>     画布布局的存放位置
  --claude-bin <p>    claude 可执行文件路径
  --no-open           不自动打开浏览器
  --no-spawn          禁用「在 Claude 中打开」
  --dev               每次请求都重新读取前端文件
  -h, --help          显示本帮助
  -v, --version       显示版本

画布只读取 ~/.claude，从不写回会话文件。
`

function parseArgs(argv) {
  const options = { open: true, spawnEnabled: true, all: false, dev: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => argv[++index]
    switch (arg) {
      case '--port': options.port = Number.parseInt(value(), 10); break
      case '--host': options.host = value(); break
      case '--cwd': options.cwd = value(); break
      case '--all': options.all = true; break
      case '--claude-dir': options.claudeDir = value(); break
      case '--data-file': options.dataFile = value(); break
      case '--claude-bin': options.claudeBin = value(); break
      case '--no-open': options.open = false; break
      case '--no-spawn': options.spawnEnabled = false; break
      case '--dev': options.dev = true; break
      case '-h': case '--help': options.help = true; break
      case '-v': case '--version': options.version = true; break
      default:
        if (arg.startsWith('-')) throw new Error(`未知选项: ${arg}`)
    }
  }
  return options
}

function openBrowser(url, platform = process.platform) {
  // Windows 的 start 把第一个引号参数当窗口标题，必须留空。
  const [command, args] = platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '', url]]
    : platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
}

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (options.version) {
  process.stdout.write(`${createRequire(import.meta.url)('../package.json').version}\n`)
  process.exit(0)
}

const port = Number.isInteger(options.port)
  ? options.port
  : Number.parseInt(process.env.CC_SYNAPSE_PORT ?? '', 10)

const server = await startServer({
  ...options,
  claudeDir: options.claudeDir ?? defaultClaudeDir(),
  dataFile: options.dataFile ?? join(homedir(), '.cc-synapse', 'workspaces.json'),
  cwd: options.cwd ?? process.cwd(),
  port: Number.isInteger(port) ? port : 0,
}).catch(error => {
  process.stderr.write(`启动失败: ${error.message}\n`)
  process.exit(1)
})

process.stdout.write(`会话地图已启动: ${server.url}\n`)
process.stdout.write(options.all ? '范围: 全部项目\n' : `范围: ${options.cwd ?? process.cwd()}\n`)
if (options.open) openBrowser(server.url)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0))
  })
}
