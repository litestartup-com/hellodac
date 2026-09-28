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
 * The security contract of the public API keys (design doc manager/topics/public-api.md §5/§11):
 * the plaintext is echoed exactly once, the database holds only sha256, the five verification outcomes are
 * distinct, and **there is no probing oracle** (an unknown keyId and a wrong secret return the same reason).
 */
const db = (): Db => openDb(':memory:').db

const mint = (d: Db, over: Partial<Parameters<typeof mintApiKey>[1]> = {}) =>
  mintApiKey(d, { name: 'company backend', scopes: ['services:read', 'tasks:write'], scopeServices: ['support'], createdBy: 'admin', ...over })

/**
 * Extract the secret from the plaintext. **Do not write `token.split('_')[2]`** -- that is what caused the
 * sporadic false alarm on 2026-09-27: the old secret used base64url (which contains `_`), so splitting returned a
 * truncated string, short enough to appear by chance elsewhere, and "the list must not contain plaintext" turned
 * red at random (see the TOKEN_RE comment in src/auth/api-key.ts). No `_` in the alphabet now, so this pins both.
 */
const secretOf = (token: string): string => {
  const parts = token.split('_')
  assert.equal(parts.length, 3, `the plaintext must split into exactly three parts on '_': ${token}`)
  return parts[2]!
}

test('Key minting: the plaintext shape is fixed; the database holds only sha256 and the public prefix', () => {
  const d = db()
  const { token, key } = mint(d)
  assert.match(token, /^dac_[0-9a-f]{12}_[A-Za-z0-9-]{43}$/, 'token shape = dac_<12hex>_<43-character secret>')
  assert.equal(key.id, token.split('_')[1], 'key.id = the public prefix inside the token')
  assert.deepEqual(key.scopes, ['services:read', 'tasks:write'])
  assert.deepEqual(key.scopeServices, ['support'])
  assert.equal(key.quotaRunsDay, null, 'unlimited runs by default')
  assert.equal(key.rateLimitRpm, 60)
  assert.equal(key.maxConcurrency, 4)

  const row = d.select().from(schema.apiKey).all()[0]!
  const secret = secretOf(token)
  assert.equal(secret.length, 43)
  assert.ok(!secret.includes('_'), 'the secret must not contain the separator (otherwise any split on _ is ambiguous)')
  assert.equal(row.keyHash.length, 64, 'sha256 hex')
  assert.ok(!row.keyHash.includes(secret), 'the plaintext secret must not appear in the database')
  assert.ok(!JSON.stringify(row).includes(secret), 'no plaintext anywhere in the row')
})

test('Key minting: 200 keys in a row, and the secret never contains the separator (an unambiguous format is the release contract)', () => {
  const d = db()
  for (let i = 0; i < 200; i += 1) {
    const { token } = mint(d, { name: `k${i}` })
    assert.equal(token.split('_').length, 3, `ambiguous plaintext parse for key ${i}: ${token}`)
  }
})

test('Key verification: valid / malformed / unknown / revoked / expired are five distinct states, and unknown is indistinguishable from a wrong secret', () => {
  const d = db()
  const { token, key } = mint(d, { expiresAt: Date.now() + 60_000 })

  const ok = verifyApiKey(d, token)
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.key.id, key.id)

  assert.deepEqual(verifyApiKey(d, 'not-a-key'), { ok: false, reason: 'malformed' })
  assert.deepEqual(verifyApiKey(d, 'dac_short_abc'), { ok: false, reason: 'malformed' })
  assert.deepEqual(verifyApiKey(d, `dac_${'f'.repeat(12)}_${'a'.repeat(43)}`), { ok: false, reason: 'unknown' })

  // Right prefix plus a wrong secret: same reason as "unknown prefix", so no return-value difference can probe whether a keyId exists
  const wrongSecret = `dac_${key.id}_${'b'.repeat(43)}`
  assert.deepEqual(verifyApiKey(d, wrongSecret), { ok: false, reason: 'unknown' })

  revokeApiKey(d, key.id)
  assert.deepEqual(verifyApiKey(d, token), { ok: false, reason: 'revoked' })

  const d2 = db()
  // The expiry path: mint normally first, then push expires_at into the past (simulating the passage of time).
  // Minting with a time already in the past is a caller bug and the authorization layer refuses it outright (see below).
  const expiring = mint(d2, { expiresAt: Date.now() + 60_000 })
  d2.update(schema.apiKey).set({ expiresAt: Date.now() - 1 }).where(eq(schema.apiKey.id, expiring.key.id)).run()
  assert.deepEqual(verifyApiKey(d2, expiring.token), { ok: false, reason: 'expired' })

  assert.throws(() => mint(db(), { expiresAt: Date.now() - 1 }), /invalid_expires_at/)
  assert.throws(() => mint(db(), { scopes: ['root:everything'] as never }), /unknown_scope/)
  assert.throws(() => mint(db(), { scopes: [] }), /key_scopes_required/)
  assert.throws(() => mint(db(), { quotaRunsDay: 0 }), /invalid_quota_runs_day/)
})

test('lastUsedAt throttling: no repeat database write within a minute (writing on every call just burns writes)', () => {
  const d = db()
  const { token, key } = mint(d)
  const read = () => d.select().from(schema.apiKey).where(eq(schema.apiKey.id, key.id)).all()[0]!.lastUsedAt

  assert.equal(read(), null, 'no last-used time right after minting')
  verifyApiKey(d, token)
  const first = read()
  assert.ok(first !== null, 'the first verification records lastUsedAt')

  verifyApiKey(d, token)
  assert.equal(read(), first, 'a second verification within the minute does not write again')

  // Push lastUsedAt back two minutes; the next verification should write again
  d.update(schema.apiKey).set({ lastUsedAt: Date.now() - 120_000 }).where(eq(schema.apiKey.id, key.id)).run()
  verifyApiKey(d, token)
  assert.ok((read() ?? 0) > (first ?? 0), 'the timestamp is recorded again once the throttle window has passed')
})

test('Scopes and service ranges: hasScope matches exactly; the service range supports the * wildcard', () => {
  const d = db()
  const { key } = mint(d, { scopes: ['tasks:write'], scopeServices: ['*'] })
  assert.equal(hasScope(key, 'tasks:write'), true)
  assert.equal(hasScope(key, 'interactions:write'), false, 'a scope that was not granted does not pass')
  assert.equal(allowsService(key, 'support'), true)
  assert.equal(allowsService(key, 'anything-else'), true, 'the * wildcard')

  const { key: narrow } = mint(d, { scopeServices: ['support'] })
  assert.equal(allowsService(narrow, 'support'), true)
  assert.equal(allowsService(narrow, 'report'), false)
})

test('Revocation and listing: the row stays after revocation (billing and audit stay traceable); the list holds no plaintext', () => {
  const d = db()
  const { token, key } = mint(d)
  assert.equal(revokeApiKey(d, key.id), true)
  assert.equal(revokeApiKey(d, key.id), true, 'revoking twice is idempotent')
  assert.equal(revokeApiKey(d, 'nope'), false, 'an unknown id returns false')

  const rows = listApiKeys(d)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, key.id)
  assert.ok(rows[0]!.revokedAt !== null)
  assert.ok(!JSON.stringify(rows).includes(secretOf(token)), 'the list API never returns plaintext')
})
