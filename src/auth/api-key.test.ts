import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { openDb, schema, type Db } from '../db/index.js'
import {
  allowsService,
  hasScope,
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  verifyApiKey,
} from './api-key.js'

/**
 * 对外 API 钥匙的安全契约（设计稿 manager/topics/public-api.md §5/§11）：
 * 明文只回显一次、库里只有 sha256、五种校验结果分明、且**不给探测口**
 * （未知 keyId 与错误 secret 返回同一个原因）。
 */
const db = (): Db => openDb(':memory:').db

const mint = (d: Db, over: Partial<Parameters<typeof mintApiKey>[1]> = {}) =>
  mintApiKey(d, { name: '公司后端', scopes: ['services:read', 'tasks:write'], scopeServices: ['support'], createdBy: 'admin', ...over })

/**
 * 从明文里取 secret。**不要写 `token.split('_')[2]`**——2026-09-27 的偶发误报就是它：
 * 当年 secret 用 base64url（含 `_`），切分拿到的是被截断的短串，短到会在别处偶然出现，
 * 于是"列表不得含明文"这类断言随机变红（见 src/auth/api-key.ts 的 TOKEN_RE 注释）。
 * 现在 secret 字母表里没有 `_`，切分不再有歧义；这条断言顺手把两件事都钉住。
 */
const secretOf = (token: string): string => {
  const parts = token.split('_')
  assert.equal(parts.length, 3, `明文必须能且只能按 '_' 切成三段：${token}`)
  return parts[2]!
}

test('钥匙签发: 明文形态固定，库里只有 sha256 与公开前缀', () => {
  const d = db()
  const { token, key } = mint(d)
  assert.match(token, /^dac_[0-9a-f]{12}_[A-Za-z0-9-]{43}$/, 'token 形态 = dac_<12hex>_<43 字符 secret>')
  assert.equal(key.id, token.split('_')[1], 'key.id = token 里的公开前缀')
  assert.deepEqual(key.scopes, ['services:read', 'tasks:write'])
  assert.deepEqual(key.scopeServices, ['support'])
  assert.equal(key.quotaRunsDay, null, '默认不限次数')
  assert.equal(key.rateLimitRpm, 60)
  assert.equal(key.maxConcurrency, 4)

  const row = d.select().from(schema.apiKey).all()[0]!
  const secret = secretOf(token)
  assert.equal(secret.length, 43)
  assert.ok(!secret.includes('_'), 'secret 里不得出现分隔符（否则任何按 _ 的切分都有歧义）')
  assert.equal(row.keyHash.length, 64, 'sha256 hex')
  assert.ok(!row.keyHash.includes(secret), '库里不得出现明文 secret')
  assert.ok(!JSON.stringify(row).includes(secret), '整行都不得含明文')
})

test('钥匙签发: 连发 200 把，secret 里永远没有分隔符（格式无歧义是发布契约）', () => {
  const d = db()
  for (let i = 0; i < 200; i += 1) {
    const { token } = mint(d, { name: `k${i}` })
    assert.equal(token.split('_').length, 3, `第 ${i} 把的明文解析歧义：${token}`)
  }
})

test('钥匙校验: 有效 / 格式错 / 未知 / 吊销 / 过期 五态分明，且未知与错密钥不可区分', () => {
  const d = db()
  const { token, key } = mint(d, { expiresAt: Date.now() + 60_000 })

  const ok = verifyApiKey(d, token)
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.key.id, key.id)

  assert.deepEqual(verifyApiKey(d, 'not-a-key'), { ok: false, reason: 'malformed' })
  assert.deepEqual(verifyApiKey(d, 'dac_short_abc'), { ok: false, reason: 'malformed' })
  assert.deepEqual(verifyApiKey(d, `dac_${'f'.repeat(12)}_${'a'.repeat(43)}`), { ok: false, reason: 'unknown' })

  // 正确前缀 + 错 secret：与"未知前缀"同一原因，避免用返回差异探测 keyId 是否存在
  const wrongSecret = `dac_${key.id}_${'b'.repeat(43)}`
  assert.deepEqual(verifyApiKey(d, wrongSecret), { ok: false, reason: 'unknown' })

  revokeApiKey(d, key.id)
  assert.deepEqual(verifyApiKey(d, token), { ok: false, reason: 'revoked' })

  const d2 = db()
  // 过期路径：先正常签发，再把 expires_at 拨到过去（模拟时间流逝）。
  // 签发时就给过去的时间是调用方 bug，授权层直接拒绝（见下方）。
  const expiring = mint(d2, { expiresAt: Date.now() + 60_000 })
  d2.update(schema.apiKey).set({ expiresAt: Date.now() - 1 }).where(eq(schema.apiKey.id, expiring.key.id)).run()
  assert.deepEqual(verifyApiKey(d2, expiring.token), { ok: false, reason: 'expired' })

  assert.throws(() => mint(db(), { expiresAt: Date.now() - 1 }), /invalid_expires_at/)
  assert.throws(() => mint(db(), { scopes: ['root:everything'] as never }), /unknown_scope/)
  assert.throws(() => mint(db(), { scopes: [] }), /key_scopes_required/)
  assert.throws(() => mint(db(), { quotaRunsDay: 0 }), /invalid_quota_runs_day/)
})

test('lastUsedAt 节流: 一分钟内不重复写库（每次调用都写 = 白烧写入）', () => {
  const d = db()
  const { token, key } = mint(d)
  const read = () => d.select().from(schema.apiKey).where(eq(schema.apiKey.id, key.id)).all()[0]!.lastUsedAt

  assert.equal(read(), null, '刚签发时没有使用时间')
  verifyApiKey(d, token)
  const first = read()
  assert.ok(first !== null, '首次校验落 lastUsedAt')

  verifyApiKey(d, token)
  assert.equal(read(), first, '一分钟内的第二次校验不再写库')

  // 把 lastUsedAt 拨回两分钟前，下一次校验应重新写
  d.update(schema.apiKey).set({ lastUsedAt: Date.now() - 120_000 }).where(eq(schema.apiKey.id, key.id)).run()
  verifyApiKey(d, token)
  assert.ok((read() ?? 0) > (first ?? 0), '超过节流窗口后重新落时间')
})

test('作用域与服务范围: hasScope 精确匹配；服务范围支持 * 通配', () => {
  const d = db()
  const { key } = mint(d, { scopes: ['tasks:write'], scopeServices: ['*'] })
  assert.equal(hasScope(key, 'tasks:write'), true)
  assert.equal(hasScope(key, 'interactions:write'), false, '未授予的 scope 不放行')
  assert.equal(allowsService(key, 'support'), true)
  assert.equal(allowsService(key, 'anything-else'), true, '* 通配')

  const { key: narrow } = mint(d, { scopeServices: ['support'] })
  assert.equal(allowsService(narrow, 'support'), true)
  assert.equal(allowsService(narrow, 'report'), false)
})

test('吊销与列表: 吊销后行保留（账目与审计可追），列表不含明文', () => {
  const d = db()
  const { token, key } = mint(d)
  assert.equal(revokeApiKey(d, key.id), true)
  assert.equal(revokeApiKey(d, key.id), true, '重复吊销是幂等的')
  assert.equal(revokeApiKey(d, 'nope'), false, '未知 id 返回 false')

  const rows = listApiKeys(d)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, key.id)
  assert.ok(rows[0]!.revokedAt !== null)
  assert.ok(!JSON.stringify(rows).includes(secretOf(token)), '列表接口永不返回明文')
})
