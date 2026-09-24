import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { registerI18nRoutes } from './i18n.js'
import { DEFAULT_LOCALE } from '../i18n/index.js'

const boot = async () => {
  const app = Fastify()
  registerI18nRoutes(app)
  return app
}

test('DAC v1.0.0: /api/i18n 吐出品牌与字典（CSP 禁内联脚本，客户端只能这样取）', async () => {
  const app = await boot()
  const res = await app.inject({ method: 'GET', url: '/api/i18n/en' })
  assert.equal(res.statusCode, 200)
  const body = res.json<{ locale: string; locales: string[]; brand: { name: string; repoUrl: string }; dict: Record<string, string> }>()
  assert.equal(body.locale, 'en')
  assert.deepEqual(body.locales, ['en', 'zh-CN'])
  assert.equal(body.brand.name, 'DAC')
  assert.match(body.brand.repoUrl, /^https:\/\//)
  assert.equal(body.dict['nav.nodes'], 'Nodes')
  assert.ok(Object.keys(body.dict).length > 50, '字典不能是空壳')
  await app.close()
})

test('DAC v1.0.0: 未知语言回退基准语言（不 404、不回显输入）', async () => {
  const app = await boot()
  const res = await app.inject({ method: 'GET', url: '/api/i18n/klingon' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<{ locale: string }>().locale, DEFAULT_LOCALE)
  const zh = await app.inject({ method: 'GET', url: '/api/i18n/zh-CN' })
  assert.equal(zh.json<{ dict: Record<string, string> }>().dict['nav.nodes'], '节点')
  await app.close()
})
