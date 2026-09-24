import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { registerSecurityHeaders } from './security.js'

/**
 * P1-1 回归：安全响应头。
 *
 * 现场：manager 一个安全头都不发 —— 无 CSP、无 X-Content-Type-Options、
 * 无 Referrer-Policy。前端有 52 处 innerHTML 直接吃模型输出/工作区文件/节点日志，
 * 唯一防线是手写的 escape-first 渲染器；CSP 是这层之外的第二道闸。
 *
 * 两条部署形态的约束（不能踩）：
 *  - 明文 HTTP 也是受支持的部署（nginx 三模式之一）→ 绝不能发
 *    upgrade-insecure-requests，也不能在非 TLS 下发 HSTS，否则浏览器会把
 *    可用的 HTTP 站点升级/钉死成不可访问的 HTTPS。
 *  - 内联样式属性在 board/spend 的渲染里在用 → style-src 必须放行 unsafe-inline，
 *    但 script-src 绝不放行。
 */

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const headersOf = async (secure: boolean): Promise<Record<string, string>> => {
  const app = Fastify()
  await registerSecurityHeaders(app, secure)
  app.get('/', async (_request, reply) => reply.type('text/html').send('<p>ok</p>'))
  const response = await app.inject({ method: 'GET', url: '/' })
  await app.close()
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(response.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  }
  return out
}

test('P1-1: CSP 禁止内联脚本，且不含会打断明文 HTTP 部署的指令', async () => {
  const headers = await headersOf(false)
  const csp = headers['content-security-policy'] ?? ''
  assert.ok(csp !== '', '必须发 Content-Security-Policy')
  assert.match(csp, /script-src [^;]*'self'/, "script-src 必须限定 'self'")
  assert.doesNotMatch(csp, /script-src [^;]*'unsafe-inline'/, 'script-src 绝不放行内联脚本')
  assert.doesNotMatch(csp, /script-src [^;]*'unsafe-eval'/)
  assert.doesNotMatch(csp, /upgrade-insecure-requests/, '明文 HTTP 部署会被它打断')
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /object-src 'none'/)
  // 前端在用内联 style 属性（board/spend）——放行样式，但只放行样式
  assert.match(csp, /style-src [^;]*'unsafe-inline'/)
})

test('P1-1: 基础安全头齐备；HSTS 只在 TLS 形态下发', async () => {
  const plain = await headersOf(false)
  assert.equal(plain['x-content-type-options'], 'nosniff')
  assert.ok((plain['referrer-policy'] ?? '') !== '')
  assert.ok((plain['x-frame-options'] ?? '') !== '' || /frame-ancestors/.test(plain['content-security-policy'] ?? ''))
  assert.equal(plain['strict-transport-security'], undefined, '明文 HTTP 下发 HSTS 会把站点钉死在 HTTPS')

  const tls = await headersOf(true)
  assert.match(tls['strict-transport-security'] ?? '', /max-age=\d+/)
})

test('P1-1: 登录页不得含内联脚本（否则 CSP 会拦掉登录）', () => {
  const html = readFileSync(join(publicDir, 'login.html'), 'utf8')
  // 只允许带 src 的 <script>
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    assert.match(tag, /\ssrc=/, `login.html 的 ${tag} 必须外链`)
  }
  assert.ok(html.includes('/assets/login.js'), '登录逻辑应在 /assets/login.js')
})
