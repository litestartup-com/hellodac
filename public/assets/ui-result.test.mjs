// 债务 F6:apiJson 统一 Result 层(ui.js)行为测试——node:test,CI test:web 常驻。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { apiJson, showError, bannerHtml } from './ui.js'

/**
 * 伪造全局 fetch。body 为字符串时响应不是 JSON(JSON.parse 抛错)。
 * @param {number} status
 * @param {unknown} body
 */
const fakeFetch = (status, body) => {
  const json = async () => {
    if (typeof body === 'string') throw new Error('not json')
    return body
  }
  globalThis.fetch = mock.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    clone: () => ({ async json() { return json() } }),
    json,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
  }))
}

const reset = () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.document = { cookie: '', getElementById: () => null }
}

test('债务 F6: ok 响应 → { ok:true, status, data }', async () => {
  try {
    reset()
    fakeFetch(200, { months: ['2026-09'] })
    const r = await apiJson('/api/usage')
    assert.deepEqual(r, { ok: true, status: 200, data: { months: ['2026-09'] } })
  } finally {
    mock.timers.reset()
  }
})

test('债务 F6: 非 ok 响应 → { ok:false, status, error, detail },JSON 错误体可读', async () => {
  try {
    reset()
    fakeFetch(400, { error: 'bad_month', detail: '月份格式不对' })
    const r = await apiJson('/api/usage?month=x')
    assert.deepEqual(r, { ok: false, status: 400, error: 'bad_month', detail: '月份格式不对' })
  } finally {
    mock.timers.reset()
  }
})

test('债务 F6: 非 JSON 错误体 → detail 回退到 HTTP 状态,不抛', async () => {
  try {
    reset()
    fakeFetch(500, '<html>boom</html>')
    const r = await apiJson('/api/usage')
    assert.deepEqual(r, { ok: false, status: 500, error: 'http_error', detail: 'HTTP 500' })
  } finally {
    mock.timers.reset()
  }
})

test('债务 F6: 401 原样进 Result(是否跳登录是页面的事)', async () => {
  try {
    reset()
    fakeFetch(401, { error: 'unauthorized' })
    const r = await apiJson('/api/usage')
    assert.equal(r.ok, false)
    assert.equal(r.status, 401)
  } finally {
    mock.timers.reset()
  }
})

test('债务 F6: showError 输出共享 banner 且转义 detail(不再回退手写样板)', () => {
  const html = showError({ ok: false, status: 500, error: 'x', detail: '<script>alert(1)</script>' }, '读取失败')
  assert.ok(html.includes('读取失败'))
  assert.ok(!html.includes('<script>'), 'detail 必须转义')
  assert.ok(html.includes('&lt;script&gt;'))
  const reference = bannerHtml({ level: 'bad', title: '读取失败', body: 'x' })
  assert.ok(html.startsWith(reference.slice(0, reference.indexOf('读取失败'))), '与 bannerHtml 同款骨架')
})

test('债务 F6: ok Result 的 showError 返回空串(只渲染失败)', () => {
  assert.equal(showError({ ok: true, status: 200, data: null }, '读取失败'), '')
})
