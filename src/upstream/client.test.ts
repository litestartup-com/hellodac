import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { UpstreamClient } from './client.js'
import { UpstreamError } from './rpc.js'
import type { ResolvedEndpoint } from '../config.js'

/** A one-shot HTTP server: it replays the responses in script order. */
const serve = async (script: Array<{ status: number; body: string }>): Promise<{ base: string; hits: number[]; close: () => Promise<void> }> => {
  const hits: number[] = []
  const server: Server = createServer((req, res) => {
    hits.push(req.statusCode ?? 0)
    const step = script.shift() ?? { status: 500, body: 'script exhausted' }
    res.writeHead(step.status, { 'content-type': 'application/json' })
    res.end(step.body)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}/api-gw/v1`,
    hits,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  }
}

const ep = (base: string): ResolvedEndpoint => ({
  id: 'A',
  url: 'http://127.0.0.1:1',
  driver: 'apiproxy',
  prefix: '/api',
  key: '',
  sandboxBase: base,
  sandboxKey: 'apigw-test',
  spawn: null, access: null,
})

test('Hive plan 2 P6 regression: the gateway settings race -- a 401 hint retries once, then succeeds (DSH-FACTS section 7)', async () => {
  const { base, hits, close } = await serve([
    { status: 401, body: JSON.stringify({ error: 'unauthorized', hint: 'Provide X-API-Key. POST /api-gw/v1/key provisions a key (first call only).' }) },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ])
  try {
    await new UpstreamClient(ep(base)).setSandboxMode('sess-1', 'workspace-write')
    assert.equal(hits.length, 2, 'a race hint -> retry once')
  } finally {
    await close()
  }
})

test('Hive plan 2 P6 regression: any other 401 (a genuinely wrong key) is not retried, and is thrown as-is', async () => {
  const { base, hits, close } = await serve([
    { status: 401, body: JSON.stringify({ error: 'unauthorized', hint: 'Provide X-API-Key (or Authorization: Bearer <key>).' }) },
  ])
  try {
    await assert.rejects(
      () => new UpstreamClient(ep(base)).setSandboxMode('sess-2', 'workspace-write'),
      (error: unknown) => error instanceof UpstreamError && error.message.includes('sandbox-mode 401'),
    )
    assert.equal(hits.length, 1, 'a non-race hint is not retried')
  } finally {
    await close()
  }
})

test('Hive plan 2 P6 regression: a first call that is already 200 is sent only once', async () => {
  const { base, hits, close } = await serve([{ status: 200, body: JSON.stringify({ ok: true }) }])
  try {
    await new UpstreamClient(ep(base)).setSandboxMode('sess-3', 'read-only')
    assert.equal(hits.length, 1)
  } finally {
    await close()
  }
})
