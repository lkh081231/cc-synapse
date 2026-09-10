// 语法检查：本项目零构建，`build` 只做 node --check。
// 遍历而非硬编码文件列表，免得每加一个 src/ 文件就要改 package.json。
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const roots = ['.', 'src', 'src/adapters', 'bin']

async function jsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter(e => e.isFile() && e.name.endsWith('.js')).map(e => join(dir, e.name))
}

const files = (await Promise.all(roots.map(jsFiles))).flat()
let failed = 0
for (const file of files) {
  try {
    await run(process.execPath, ['--check', file])
  } catch (error) {
    failed += 1
    console.error(`✖ ${file}\n${error.stderr ?? error.message}`)
  }
}
console.log(`${failed === 0 ? '✓' : '✖'} 语法检查 ${files.length - failed}/${files.length}`)
process.exit(failed === 0 ? 0 : 1)
