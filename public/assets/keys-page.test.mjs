import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 页面脚本运行时冒烟：把 keys.js 当作真模块跑一遍，断言它没有抛错、且把数据
 * 渲染进了对应节点。这是给 2026-09-27 事故补的后悔药——页面所有部件都在、API 也
 * 正常，唯独脚本里 `apiJson` 的返回被当成 `Response` 用了 `.json()`，页面永远停在
 * "Loading…"，而 `node --check` 与"资源 200"都查不出这一类错。
 *
 * 约束：本测试依赖模块顶层副作用，node --test 每文件独立进程 ✓。
 */
const nodes = new Map()

const el = (id) => {
  const existing = nodes.get(id)
  if (existing !== undefined) return existing
  const node = { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', options: [], listeners: {}, addEventListener: (type, fn) => { node.listeners[type] = fn } }
  nodes.set(id, node)
  return node
}

globalThis.document = {
  documentElement: { lang: 'en' },
  cookie: '',
  hidden: false,
  getElementById: (id) => nodes.get(id) ?? null,
  addEventListener: () => undefined,
  querySelectorAll: () => [
    { value: 'services:read' },
    { value: 'usage:read' },
  ],
}
globalThis.window = globalThis
globalThis.HTMLElement = class {}
// poll() 会挂 15s 定时器：测试里不给它真正计时（轮询行为不是本测试目标）。
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => undefined

// 预置页面节点（keys.html 里的 id 全集）
for (const id of ['keys-listener', 'key-services', 'key-scopes', 'key-create', 'key-create-msg', 'keys-list', 'keys-refresh', 'key-name', 'key-quota', 'key-token', 'key-form']) el(id)

const keyFixture = {
  id: 'b4c36b603b1e',
  name: '计费服务',
  scopes: ['services:read', 'tasks:write'],
  scopeServices: ['support'],
  quotaRunsDay: 200,
  rateLimitRpm: 60,
  maxConcurrency: 4,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: 1_790_000_000_000,
}

globalThis.fetch = async (url, options) => {
  const path = String(url)
  if (path.includes('/api/i18n/')) return { ok: true, json: async () => ({ locale: 'en', dict: { 'keys.listenerUp': 'listening on' }, locales: [] }) }
  if (path.endsWith('/api/keys') && options?.method === 'POST') {
    postBodies.push(options?.body ?? '')
    return { ok: true, status: 201, json: async () => ({ token: 'dac_9f2c1ab7e2d4_TESTTOKEN', key: { id: '9f2c1ab7e2d4' } }) }
  }
  if (path.endsWith('/api/keys')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        keys: [keyFixture],
        publicApi: { status: 'listening', host: '127.0.0.1', port: 8081, detail: null },
        services: [{ id: 'support', label: '客服' }],
      }),
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
}
const postBodies = []

test('keys 页面脚本：加载不抛错，且把数据渲染进对应节点（防 "Loading…" 事故）', async () => {
  await import('./keys.js')

  // load() 是顶层 await 之后的同步链；给它一个微任务窗口让渲染完成。
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const listener = nodes.get('keys-listener')
  assert.ok(listener !== undefined && listener.innerHTML.includes('127.0.0.1:8081'), `门面状态渲染失败：${listener?.innerHTML}`)

  const list = nodes.get('keys-list')
  assert.ok(list !== undefined && list.innerHTML.includes('计费服务'), `钥匙列表渲染失败：${list?.innerHTML}`)
  assert.ok(list !== undefined && list.innerHTML.includes('b4c36b603b1e'), '列表应显示 keyId')

  const services = nodes.get('key-services')
  assert.ok(services !== undefined && services.innerHTML.includes('support'), '服务下拉应填充')

  const msg = nodes.get('key-create-msg')
  assert.ok(msg !== undefined && msg.textContent === '', '配置里有服务时不应显示"无服务"提示')
})

test('keys 表单：提交 → 签发 → 明文只展示一次（驱动真实表单处理器）', async () => {
  await import('./keys.js')
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const form = nodes.get('key-form')
  assert.ok(form !== undefined && typeof form.listeners?.submit === 'function', '表单应注册 submit 处理器')

  const nameEl = nodes.get('key-name')
  const serviceEl = nodes.get('key-services')
  nameEl.value = '验收钥匙'
  serviceEl.value = 'support'

  await form.listeners.submit({ preventDefault: () => undefined })
  await new Promise((resolve) => realSetTimeout(resolve, 20))

  const body = postBodies[0]
  assert.ok(body !== undefined, '提交应发出 POST /api/keys')
  const parsed = JSON.parse(body)
  assert.equal(parsed.name, '验收钥匙')
  assert.deepEqual(parsed.services, ['support'])
  assert.deepEqual(parsed.scopes, ['services:read', 'usage:read'], '默认只读 scope（勾选项）')

  const reveal = nodes.get('key-token')
  assert.ok(reveal !== undefined && reveal.hidden === false, '签发成功后应展示明文区')
  assert.ok(reveal !== undefined && reveal.innerHTML.includes('TESTTOKEN'), '明文区应包含 token')
})
