import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { UpstreamClient } from './client.js'
import { UpstreamError } from './rpc.js'
import type { ResolvedEndpoint } from '../config.js'

/** 一次性 HTTP 服务：按脚本顺序回放响应。 */
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

test('蜂群2计划 P6 回归: 网关 settings 竞态的 401 hint 重试一次后成功（DSH-FACTS §7）', async () => {
  const { base, hits, close } = await serve([
    { status: 401, body: JSON.stringify({ error: 'unauthorized', hint: 'Provide X-API-Key. POST /api-gw/v1/key provisions a key (first call only).' }) },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ])
  try {
    await new UpstreamClient(ep(base)).setSandboxMode('sess-1', 'workspace-write')
    assert.equal(hits.length, 2, '竞态 hint → 重试一次')
  } finally {
    await close()
  }
})

test('蜂群2计划 P6 回归: 其它 401（真钥匙错）不重试、原样抛出', async () => {
  const { base, hits, close } = await serve([
    { status: 401, body: JSON.stringify({ error: 'unauthorized', hint: 'Provide X-API-Key (or Authorization: Bearer <key>).' }) },
  ])
  try {
    await assert.rejects(
      () => new UpstreamClient(ep(base)).setSandboxMode('sess-2', 'workspace-write'),
      (error: unknown) => error instanceof UpstreamError && error.message.includes('sandbox-mode 401'),
    )
    assert.equal(hits.length, 1, '非竞态 hint 不重试')
  } finally {
    await close()
  }
})

test('蜂群2计划 P6 回归: 首调即 200 只发一次', async () => {
  const { base, hits, close } = await serve([{ status: 200, body: JSON.stringify({ ok: true }) }])
  try {
    await new UpstreamClient(ep(base)).setSandboxMode('sess-3', 'read-only')
    assert.equal(hits.length, 1)
  } finally {
    await close()
  }
})
