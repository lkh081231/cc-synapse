import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { WorkspaceStore } from './store.js'
import { Scanner } from './scanner.js'
import { defaultClaudeDir } from './adapters/claude.js'
import { openClaudeSession } from './spawn.js'

const ASSETS = {
  '/app.js': ['application/javascript; charset=utf-8', new URL('../app.js', import.meta.url)],
  '/styles.css': ['text/css; charset=utf-8', new URL('../styles.css', import.meta.url)],
}

/**
 * 起一个只读的本地画布服务。
 *
 * 会话数据始终从 ~/.claude 重新读取，服务端只持久化用户摆出来的布局。
 */
export async function startServer(options = {}) {
  const {
    dataFile,
    claudeDir = defaultClaudeDir(),
    cwd = process.cwd(),
    all = false,
    port = 0,
    host = '127.0.0.1',
    spawnEnabled = true,
    claudeBin = null,
    dev = false,
  } = options

  const store = new WorkspaceStore(dataFile)
  const scanner = new Scanner({ claudeDir, cwd: all ? null : cwd, all })
  const assets = new Map()
  const state = { revision: 0, sessions: new Map(), scanning: null }

  async function rescan() {
    // 同时到来的请求共用一次扫描，避免重复解析同一批文件。
    state.scanning ??= (async () => {
      try {
        const sessions = await scanner.scan()
        state.sessions = new Map(sessions.map(session => [session.id, session]))
        await store.syncClaude(sessions)
        state.revision += 1
      } finally {
        state.scanning = null
      }
    })()
    return state.scanning
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent) sendJson(res, statusOf(error), { error: error?.message ?? '服务器错误' })
      else res.end()
    })
  })

  async function handle(req, res) {
    // 第一层防护是只监听回环地址；这里挡住的是指向本机的 DNS 重绑定。
    if (!trusted(req, host)) return sendJson(res, 403, { error: '不被信任的 Host' })
    // 非 GET 请求会改状态或启动进程，必须确认来自本页面而不是别处的网页。
    if (req.method !== 'GET' && !sameOrigin(req, host)) return sendJson(res, 403, { error: '跨站请求被拒绝' })

    const url = new URL(req.url ?? '/', 'http://cc-synapse.local')
    const path = url.pathname

    if (path === '/' && req.method === 'GET') return sendHtml(res, page())
    if (path === '/favicon.svg' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
      return res.end(FAVICON)
    }
    if (ASSETS[path] !== undefined && req.method === 'GET') return sendAsset(res, path, assets, dev)

    if (path === '/api/state' && req.method === 'GET') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '', 10)
      // 修订号没变时回 204，前端可以放心地每秒轮询。
      if (Number.isInteger(since) && since === state.revision) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        return res.end()
      }
      return sendJson(res, 200, { revision: state.revision, workspaces: await store.list() })
    }
    if (path === '/api/workspaces' && req.method === 'GET') {
      return sendJson(res, 200, { revision: state.revision, workspaces: await store.list() })
    }
    if (path === '/api/rescan' && req.method === 'POST') {
      await rescan()
      return sendJson(res, 200, { revision: state.revision })
    }

    const workspaceMatch = /^\/api\/workspaces\/([\w-]+)$/.exec(path)
    if (workspaceMatch !== null && req.method === 'GET') {
      return sendJson(res, 200, { workspace: await store.get(workspaceMatch[1]) })
    }

    const threadMatch = /^\/api\/threads\/([\w-]+)$/.exec(path)
    if (threadMatch !== null) {
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        return sendJson(res, 200, { thread: await store.updateThread(threadMatch[1], body) })
      }
      if (req.method === 'DELETE') return sendJson(res, 200, await store.removeThread(threadMatch[1]))
    }

    const openMatch = /^\/api\/sessions\/([\w-]+)\/open$/.exec(path)
    if (openMatch !== null && req.method === 'POST') {
      if (!spawnEnabled) return sendJson(res, 403, { error: '本次启动已禁用唤起会话' })
      // 工作目录只从服务端已知的会话里取，绝不接受请求体传入，
      // 否则这个接口就变成了任意目录执行。
      const session = state.sessions.get(openMatch[1])
      if (session === undefined) return sendJson(res, 404, { error: '会话不存在' })
      await openClaudeSession({ cwd: session.cwd, sessionId: session.id, claudeBin })
      return sendJson(res, 200, { opened: session.id })
    }
    if (path === '/api/sessions/new' && req.method === 'POST') {
      if (!spawnEnabled) return sendJson(res, 403, { error: '本次启动已禁用唤起会话' })
      const body = await readJson(req).catch(() => ({}))
      const target = [...state.sessions.values()].find(session => session.cwd === body?.cwd)
      await openClaudeSession({ cwd: target?.cwd ?? cwd, claudeBin })
      return sendJson(res, 200, { opened: null })
    }

    return sendJson(res, 404, { error: '接口不存在' })
  }

  await rescan()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  const address = server.address()
  return {
    url: `http://${host}:${address.port}/`,
    port: address.port,
    rescan,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function trusted(req, host) {
  const header = typeof req.headers.host === 'string' ? req.headers.host : ''
  const hostname = header.replace(/:\d+$/, '').toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === host.toLowerCase()
}

/**
 * 浏览器给同源请求带 Sec-Fetch-Site；老浏览器退回比对 Origin。
 * 两者都没有时只可能来自非浏览器客户端，放行。
 */
function sameOrigin(req, host) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === host.toLowerCase()
  } catch {
    return false
  }
}

async function sendAsset(res, path, cache, dev) {
  const [type, url] = ASSETS[path]
  if (dev || !cache.has(path)) cache.set(path, await readFile(url))
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(cache.get(path))
}

function sendHtml(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const MAX_BODY_BYTES = 32 * 1024

async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error('请求内容过大'), { status: 413 })
    chunks.push(chunk)
  }
  if (length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求不是有效 JSON'), { status: 400 })
  }
}

function statusOf(error) {
  if (Number.isInteger(error?.status)) return error.status
  const name = error?.constructor?.name
  if (name === 'NotFoundError') return 404
  if (name === 'InputError') return 400
  return 500
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="none" stroke="#2563eb" stroke-width="2"><path d="M9 10.5 16 7l7 3.5M9 10.5v8L16 22m0-15v15m7-11.5v8L16 22"/><circle cx="9" cy="10" r="2.5" fill="#2563eb"/><circle cx="23" cy="10" r="2.5" fill="#2563eb"/><circle cx="16" cy="23" r="2.5" fill="#2563eb"/></g></svg>`

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Claude 会话地图</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>`
}
