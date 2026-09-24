import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { respond } from './respond.js'

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

describe('respond', () => {
  it('sends the client-response envelope to /respond', async () => {
    const captured: { url?: string; body?: string } = {}
    const srv = await startServer(async (req, res) => {
      captured.url = req.url ?? ''
      captured.body = await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: true }))
    })
    try {
      const receipt = await respond(
        { base: srv.url, key: '' },
        'rpc-1',
        { ok: true, value: { sessionId: 's1', answer: { answers: [] } } },
      )
      assert.deepEqual(receipt, { accepted: true })
      assert.equal(captured.url, '/respond')
      const body = JSON.parse(captured.body!)
      assert.equal(body.type, 'client-response')
      assert.equal(body.rpcId, 'rpc-1')
      assert.deepEqual(body.result, { ok: true, value: { sessionId: 's1', answer: { answers: [] } } })
    } finally {
      await srv.close()
    }
  })

  it('parses a not-pending receipt', async () => {
    const srv = await startServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: false, reason: 'not-pending' }))
    })
    try {
      const receipt = await respond({ base: srv.url, key: '' }, 'rpc-1', { ok: true, value: {} })
      assert.deepEqual(receipt, { accepted: false, reason: 'not-pending' })
    } finally {
      await srv.close()
    }
  })

  it('parses a bad-response receipt', async () => {
    const srv = await startServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: false, reason: 'bad-response' }))
    })
    try {
      const receipt = await respond({ base: srv.url, key: '' }, 'rpc-1', { ok: true, value: {} })
      assert.deepEqual(receipt, { accepted: false, reason: 'bad-response' })
    } finally {
      await srv.close()
    }
  })

  it('carries a not-ok (decline) result onto the wire', async () => {
    const captured: { body?: string } = {}
    const srv = await startServer(async (req, res) => {
      captured.body = await readBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: true }))
    })
    try {
      await respond({ base: srv.url, key: '' }, 'rpc-1', {
        ok: false,
        error: { code: 'cancelled', message: 'the user cancelled ask_user_question', details: {} },
      })
      const body = JSON.parse(captured.body!)
      assert.equal(body.result.ok, false)
      assert.equal(body.result.error.code, 'cancelled')
    } finally {
      await srv.close()
    }
  })

  it('throws on non-200', async () => {
    const srv = await startServer(async (_req, res) => {
      res.writeHead(404)
      res.end('not found')
    })
    try {
      await assert.rejects(() => respond({ base: srv.url, key: '' }, 'rpc-1', { ok: true, value: {} }), /HTTP 404/)
    } finally {
      await srv.close()
    }
  })
})
