import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { startServer } from '../src/server.js'

/** 发一个可以自定义 Host 的原始请求。 */
function rawStatus(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

const claudeDir = fileURLToPath(new URL('./fixtures/claude/', import.meta.url))

async function withServer(options, run) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-synapse-server-'))
  const server = await startServer({
    claudeDir,
    dataFile: join(dir, 'workspaces.json'),
    all: true,
    port: 0,
    ...options,
  })
  try {
    await run(server)
  } finally {
    await server.close()
  }
}

const get = (server, path, init) => fetch(new URL(path, server.url), init)

test('serves the canvas shell and its assets', async () => {
  await withServer({}, async server => {
    const page = await get(server, '/')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /id="app"/)

    for (const asset of ['/app.js', '/styles.css']) {
      assert.equal((await get(server, asset)).status, 200)
    }
  })
})

test('projects scanned sessions into workspaces', async () => {
  await withServer({}, async server => {
    const body = await (await get(server, '/api/state')).json()
    assert.ok(body.revision >= 1)
    assert.ok(body.workspaces.length > 0)
    assert.ok(body.workspaces.every(workspace => workspace.kind === 'claude'))
  })
})

test('answers a polling request with 204 while nothing has changed', async () => {
  await withServer({}, async server => {
    const { revision } = await (await get(server, '/api/state')).json()
    // 前端每秒轮询一次，未变时必须便宜到可以忽略。
    assert.equal((await get(server, `/api/state?since=${revision}`)).status, 204)
    assert.equal((await get(server, `/api/state?since=${revision - 1}`)).status, 200)
  })
})

test('rejects a forged Host header', async () => {
  await withServer({}, async server => {
    // fetch 把 Host 当禁止修改的头静默丢弃，所以这条只能用底层请求来测。
    const status = await rawStatus(server.port, '/api/state', { host: 'evil.example' })
    assert.equal(status, 403)
    assert.equal(await rawStatus(server.port, '/api/state', { host: `127.0.0.1:${server.port}` }), 200)
  })
})

test('rejects a cross-site write', async () => {
  await withServer({}, async server => {
    // 这条防线守的是唤起会话的接口：别处的网页不能借浏览器启动进程。
    const response = await get(server, '/api/rescan', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(response.status, 403)
  })
})

test('keeps card positions across a rescan', async () => {
  await withServer({}, async server => {
    const { workspaces } = await (await get(server, '/api/state')).json()
    const { workspace } = await (await get(server, `/api/workspaces/${workspaces[0].id}`)).json()
    const thread = workspace.threads[0]

    const moved = await get(server, `/api/threads/${thread.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ position: { x: 512, y: 256 } }),
    })
    assert.equal(moved.status, 200)

    await server.rescan()
    const after = await (await get(server, `/api/workspaces/${workspaces[0].id}`)).json()
    const same = after.workspace.threads.find(item => item.ccSessionId === thread.ccSessionId)
    // 会话内容每次重建，但用户摆好的位置必须留下。
    assert.deepEqual(same.position, { x: 512, y: 256 })
  })
})

test('does not resurrect an archived session on the next scan', async () => {
  await withServer({}, async server => {
    const { workspaces } = await (await get(server, '/api/state')).json()
    const { workspace } = await (await get(server, `/api/workspaces/${workspaces[0].id}`)).json()
    const thread = workspace.threads[0]

    const removed = await get(server, `/api/threads/${thread.id}`, {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(removed.status, 200)

    await server.rescan()
    const after = await (await get(server, '/api/state')).json()
    const ids = []
    for (const item of after.workspaces) {
      const detail = await (await get(server, `/api/workspaces/${item.id}`)).json()
      ids.push(...detail.workspace.threads.map(entry => entry.ccSessionId))
    }
    assert.ok(!ids.includes(thread.ccSessionId))
  })
})

test('refuses to open a session it has not scanned', async () => {
  await withServer({}, async server => {
    const response = await get(server, '/api/sessions/00000000-0000-4000-8000-000000000000/open', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    // 工作目录只能来自已知会话，否则这个接口就是任意目录执行。
    assert.equal(response.status, 404)
  })
})

test('disables opening sessions when asked', async () => {
  await withServer({ spawnEnabled: false }, async server => {
    const { workspaces } = await (await get(server, '/api/state')).json()
    const { workspace } = await (await get(server, `/api/workspaces/${workspaces[0].id}`)).json()
    const response = await get(server, `/api/sessions/${workspace.threads[0].ccSessionId}/open`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(response.status, 403)
  })
})

test('reports an unknown route as missing', async () => {
  await withServer({}, async server => {
    assert.equal((await get(server, '/api/nope')).status, 404)
  })
})
