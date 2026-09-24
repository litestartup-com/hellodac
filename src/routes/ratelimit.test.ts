import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { parseTrustProxy } from '../config.js'

/**
 * P0-4 回归：登录限流不得被 X-Forwarded-For 绕过。
 *
 * 现场：`trustProxy: true` 让 `request.ip` 直接取转发头，而 @fastify/rate-limit
 * 默认以 `request.ip` 为键 —— 攻击者每次换一个 XFF 就等于没有限流，而这是
 * 暴破口令的唯一防线（无失败锁定、无验证码）。
 */

const build = async (trustProxy: boolean | string) => {
  const app = Fastify({ trustProxy })
  await app.register(rateLimit, { global: false })
  app.post('/api/login', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({ ok: true }))
  return app
}

const hammer = async (trustProxy: boolean | string): Promise<number[]> => {
  const app = await build(trustProxy)
  const codes: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      // 每次换一个转发头：这正是绕过手法
      headers: { 'x-forwarded-for': `203.0.113.${i}` },
      payload: { username: 'admin', password: 'x' },
    })
    codes.push(response.statusCode)
  }
  await app.close()
  return codes
}

test('P0-4: 轮换 X-Forwarded-For 不能绕过登录限流（默认配置）', async () => {
  const codes = await hammer(parseTrustProxy(undefined))
  assert.deepEqual(codes.slice(0, 2), [200, 200], '窗口内前两次应放行')
  assert.equal(codes[2], 429, '第三次必须被限流——键必须落在不可伪造的直连对端上')
  assert.equal(codes[3], 429)
})

test('P0-4: trustProxy=true 的旧行为确实可被绕过（这就是被修掉的缺陷）', async () => {
  const codes = await hammer(true)
  assert.deepEqual(codes, [200, 200, 200, 200], '全信任转发头时限流形同不存在')
})

test('P0-4: TRUST_PROXY 解析——默认不信任，显式配置才信任', () => {
  assert.equal(parseTrustProxy(undefined), false, '未配置时必须安全默认（不信任转发头）')
  assert.equal(parseTrustProxy(''), false)
  assert.equal(parseTrustProxy('false'), false)
  assert.equal(parseTrustProxy('0'), false)
  assert.equal(parseTrustProxy('true'), true)
  // 纯数字（“跳数”写法）不受支持：fastify 会把 '1' 当 IP 字串，静默误读
  // 比不支持更危险 —— 因此回落为不信任，并由 loadConfig 推一条启动警告
  assert.equal(parseTrustProxy('1'), false)
  assert.equal(parseTrustProxy('2'), false)
  // 具体地址/网段：只信任这一跳
  assert.equal(parseTrustProxy('127.0.0.1'), '127.0.0.1')
  assert.equal(parseTrustProxy('172.16.0.0/12, 127.0.0.1'), '172.16.0.0/12, 127.0.0.1')
})
