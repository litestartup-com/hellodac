import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../db/index.js'
import { createKey, parseKeyArgs, renderKeyList } from './apikey.js'

/**
 * 钥匙 CLI 的契约（验收步骤靠它发钥匙）：
 * - 危险默认值要向安全侧倒：只读 scope、必须显式指定服务、默认带日配额；
 * - 明文只在创建时打印一次；列表永不打印明文。
 */
test('CLI 参数: create 必填 name 与 services（不给"什么都通"的默认）', () => {
  const missing = parseKeyArgs(['create'])
  assert.ok('error' in missing, '缺参数要报错')
  assert.match(String(missing.error), /name/)

  const noServices = parseKeyArgs(['create', '--name', 'x'])
  assert.ok('error' in noServices)
  assert.match(String(noServices.error), /services/)

  const ok = parseKeyArgs(['create', '--name', '公司后端', '--services', 'support,report', '--scopes', 'services:read,tasks:write'])
  assert.ok(!('error' in ok))
  if (!('error' in ok) && ok.command === 'create') {
    assert.deepEqual(ok.options.scopeServices, ['support', 'report'])
    assert.deepEqual(ok.options.scopes, ['services:read', 'tasks:write'])
    assert.equal(ok.options.quotaRunsDay, 200, '默认带日配额（写清楚、可 --quota none 解除）')
    assert.equal(ok.options.rateLimitRpm, 60)
    assert.equal(ok.options.maxConcurrency, 4)
  }
})

test('CLI 参数: 只读默认 scope / --all-services / --quota none / 未知 scope 报错', () => {
  const readOnly = parseKeyArgs(['create', '--name', 'x', '--services', 'support'])
  assert.ok(!('error' in readOnly))
  if (!('error' in readOnly) && readOnly.command === 'create') {
    assert.deepEqual(readOnly.options.scopes, ['services:read', 'usage:read'], '默认只读')
    assert.equal(readOnly.options.expiresAt, null)
  }

  const wild = parseKeyArgs(['create', '--name', 'x', '--all-services', '--quota', 'none'])
  assert.ok(!('error' in wild))
  if (!('error' in wild) && wild.command === 'create') {
    assert.deepEqual(wild.options.scopeServices, ['*'])
    assert.equal(wild.options.quotaRunsDay, null)
  }

  const badScope = parseKeyArgs(['create', '--name', 'x', '--services', 'support', '--scopes', 'root:all'])
  assert.ok('error' in badScope)
  assert.match(String(badScope.error), /unknown scope/)
})

test('CLI 参数: revoke 要带 id；list/help 无参', () => {
  assert.ok('error' in parseKeyArgs(['revoke']))
  const revoke = parseKeyArgs(['revoke', 'abcdef123456'])
  assert.ok(!('error' in revoke) && revoke.command === 'revoke' && revoke.id === 'abcdef123456')
  assert.ok(!('error' in parseKeyArgs(['list'])))
  assert.ok(!('error' in parseKeyArgs(['help'])))
  assert.ok('error' in parseKeyArgs(['frobnicate']))
})

test('CLI 创建: 明文只回一次，库里只有哈希；列表不含明文', () => {
  const { db } = openDb(':memory:')
  const parsed = parseKeyArgs(['create', '--name', '公司后端', '--services', 'support', '--scopes', 'services:read,tasks:write', '--quota', '50'])
  assert.ok(!('error' in parsed) && parsed.command === 'create')
  if ('error' in parsed || parsed.command !== 'create') return

  const { token, key } = createKey(db, parsed.options)
  assert.match(token, /^dac_[0-9a-f]{12}_/)
  assert.equal(key.quotaRunsDay, 50)

  const listing = renderKeyList([key], Date.now())
  assert.ok(listing.includes(key.id))
  assert.ok(listing.includes('公司后端'))
  assert.ok(!listing.includes(token.split('_')[2] ?? 'x'), '列表永不打印明文')
  assert.match(listing, /50\/day/)
})
