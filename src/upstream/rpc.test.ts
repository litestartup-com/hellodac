import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMethodAllowed, rpc, UpstreamError } from './rpc.js'

// ---- whitelist ----

describe('isMethodAllowed', () => {
  const allowed = [
    'session.list', 'session.create', 'session.history',
    'session.prompt', 'session.cancel', 'session.rename',
    'session.fork', 'session.updateQueue', 'session.attachment',
    'session.models', 'session.selectModel',
    'host.describe',
  ]

  for (const m of allowed) {
    it(`allows ${m}`, () => {
      assert.equal(isMethodAllowed(m), true)
    })
  }

  const denied = [
    'host.version', // 不存在的方法：真实契约里是 host.describe
    'credentials.set', 'credentials.unset',
    'settings.mutate', 'settings.describe',
    'host.openPath', 'host.listDirectory', 'host.createDirectory',
    'llm.discoverModels',
    'respond',
    'session.delete',
    '',
    'SESSION.LIST',
    'whatever.unknown',
  ]

  for (const m of denied) {
    it(`denies "${m}"`, () => {
      assert.equal(isMethodAllowed(m), false)
    })
  }
})

// ---- rpc ----

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const startServer = (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })

const okReply = (rpcId: string, value: unknown): string =>
  JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } })

describe('rpc', () => {
  it('sends the client-request envelope and returns value on ok', async () => {
    const captured: { url?: string; body?: string } = {}
    const srv = await startServer(async (req, res) => {
      captured.url = req.url ?? ''
      captured.body = await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(okReply('test-1', { sessions: [] }))
    })
    try {
      const result = await rpc({ base: srv.url, key: '' }, 'session.list', { cursor: null })
      assert.equal(result.result.ok, true)
      assert.deepEqual(result.result.value, { sessions: [] })
      assert.equal(captured.url, '/session.list')
      const body = JSON.parse(captured.body!)
      assert.equal(body.type, 'client-request')
      assert.equal(body.method, 'session.list')
      assert.deepEqual(body.payload, { cursor: null })
      assert.ok(typeof body.rpcId === 'string')
    } finally {
      await srv.close()
    }
  })

  it('sends X-API-Key when key is non-empty', async () => {
    let headerKey: string | undefined
    const srv = await startServer(async (req, res) => {
      headerKey = req.headers['x-api-key'] as string | undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(okReply('1', null))
    })
    try {
      await rpc({ base: srv.url, key: 'secret-123' }, 'session.list')
      assert.equal(headerKey, 'secret-123')
    } finally {
      await srv.close()
    }
  })

  it('does not send X-API-Key when key is empty', async () => {
    let headerKey: string | undefined
    const srv = await startServer(async (req, res) => {
      headerKey = req.headers['x-api-key'] as string | undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(okReply('1', null))
    })
    try {
      await rpc({ base: srv.url, key: '' }, 'session.list')
      assert.equal(headerKey, undefined)
    } finally {
      await srv.close()
    }
  })

  it('throws UpstreamError on result.ok=false with the error branch', async () => {
    const srv = await startServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: '1',
        result: { ok: false, error: { code: 'internal', message: 'corrupt session log', details: {} } },
      }))
    })
    try {
      await assert.rejects(() => rpc({ base: srv.url, key: '' }, 'session.history', { sessionId: 'x' }), (err: unknown) => {
        assert.ok(err instanceof UpstreamError)
        assert.equal(err.code, 'internal')
        assert.ok(err.message.includes('corrupt session log'))
        return true
      })
    } finally {
      await srv.close()
    }
  })

  it('rejects a response missing the server-response envelope', async () => {
    const srv = await startServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: '1', result: { ok: true, value: null } }))
    })
    try {
      await assert.rejects(
        () => rpc({ base: srv.url, key: '' }, 'session.list'),
        /missing "result" field/,
      )
    } finally {
      await srv.close()
    }
  })

  it('债务 E8: ok:false 缺 error 分支 = 畸形应答,显性失败(fail-loud,不猜上游)', async () => {
    const srv = await startServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: '1', result: { ok: false } }))
    })
    try {
      await assert.rejects(
        () => rpc({ base: srv.url, key: '' }, 'session.list'),
        /missing "result" field/,
      )
    } finally {
      await srv.close()
    }
  })

  it('throws on non-200 HTTP status', async () => {
    const srv = await startServer(async (_req, res) => {
      res.writeHead(403)
      res.end('forbidden')
    })
    try {
      await assert.rejects(() => rpc({ base: srv.url, key: '' }, 'session.list'), /HTTP 403/)
    } finally {
      await srv.close()
    }
  })

  it('rejects disallowed methods without making a network call', async () => {
    await assert.rejects(
      () => rpc({ base: 'http://127.0.0.1:1', key: '' }, 'credentials.set', {}),
      /not on the whitelist/,
    )
  })
})
