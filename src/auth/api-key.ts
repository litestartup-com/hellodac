/**
 * Public-API keys (design doc: the internal design library's `manager/topics/public-api.md` §5 / §11).
 *
 * Same idea as the session / agent tokens: the plaintext is echoed **once, at creation**, and only sha256 is stored.
 * The difference is that a key belongs to a machine caller, so it also carries scopes, service range and quota -- this
 * module only stores and decides on those three; the real enforcement point is the public-api layer (the facade).
 *
 * The five verification outcomes stay distinct, but "unknown keyId" and "right prefix, wrong secret" deliberately
 * return the same reason (unknown): otherwise a caller could probe which keyIds really exist from the difference.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { schema, type Db } from '../db/index.js'

export const KEY_SCOPES = [
  'services:read',
  'usage:read',
  'tasks:write',
  'conversations:write',
  'interactions:write',
] as const
export type KeyScope = (typeof KEY_SCOPES)[number]

export interface ApiKey {
  id: string
  name: string
  scopes: KeyScope[]
  /** Service ids this key may enter; ['*'] = all. Intersected with the service agent's public flag (two doors). */
  scopeServices: string[]
  quotaRunsDay: number | null
  rateLimitRpm: number
  maxConcurrency: number
  expiresAt: number | null
  revokedAt: number | null
  lastUsedAt: number | null
  createdBy: string
  createdAt: number
}

export type VerifyResult =
  | { ok: true; key: ApiKey }
  | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' | 'expired' }

export interface MintInput {
  name: string
  scopes: readonly KeyScope[]
  scopeServices: readonly string[]
  quotaRunsDay?: number | null
  rateLimitRpm?: number
  maxConcurrency?: number
  expiresAt?: number | null
  createdBy: string
}

const KEY_ID_RE = /^[0-9a-f]{12}$/
/**
 * The plaintext shape: `dac_<12 hex keyId>_<43-character secret>`.
 *
 * **The secret's alphabet has no `_` in it**: `_` is the separator, yet base64url treats it as an ordinary
 * character, so "a secret with an underscore in it" makes any parsing that splits on `_` (a customer's own
 * integration, a log-scrubbing script, our tests) pick up the wrong fragment -- on 2026-09-27 that is what made a
 * "the list must not contain plaintext" assertion flake: `split('_')[2]` returned a truncated short string that
 * happened to appear elsewhere and was judged a leak. Minting now skips any encoding containing `_` (about half are skipped, a negligible cost), and the length and entropy are unchanged.
 */
const TOKEN_RE = /^dac_([0-9a-f]{12})_([A-Za-z0-9-]{43})$/
/** Writing lastUsedAt on every call = a wasted write; once a minute is enough for the UI to show "last used". */
const LAST_USED_THROTTLE_MS = 60_000
const MAX_RPM = 6_000
const MAX_CONCURRENCY = 64

const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex')

const parseList = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v !== '') : []
  } catch {
    return []
  }
}

/** Drop any unknown scope: when the database has been hand-edited into odd values, denying is better than loosening. */
const parseScopes = (raw: string): KeyScope[] =>
  parseList(raw).filter((v): v is KeyScope => (KEY_SCOPES as readonly string[]).includes(v))

const toApiKey = (row: typeof schema.apiKey.$inferSelect): ApiKey => ({
  id: row.id,
  name: row.name,
  scopes: parseScopes(row.scopes),
  scopeServices: parseList(row.scopeServices),
  quotaRunsDay: row.quotaRunsDay,
  rateLimitRpm: row.rateLimitRpm,
  maxConcurrency: row.maxConcurrency,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  lastUsedAt: row.lastUsedAt,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
})

const assertMintInput = (input: MintInput, now: number): void => {
  if (input.name.trim() === '') throw new Error('key_name_required')
  if (input.scopes.length === 0) throw new Error('key_scopes_required')
  const bad = input.scopes.filter((s) => !(KEY_SCOPES as readonly string[]).includes(s))
  if (bad.length > 0) throw new Error(`unknown_scope: ${bad.join(', ')}`)
  if (input.scopeServices.length === 0 || input.scopeServices.some((s) => s.trim() === '')) {
    throw new Error('key_scope_services_required')
  }
  if (input.quotaRunsDay !== undefined && input.quotaRunsDay !== null && (!Number.isInteger(input.quotaRunsDay) || input.quotaRunsDay < 1)) {
    throw new Error('invalid_quota_runs_day')
  }
  if (input.rateLimitRpm !== undefined && (!Number.isInteger(input.rateLimitRpm) || input.rateLimitRpm < 1 || input.rateLimitRpm > MAX_RPM)) {
    throw new Error(`invalid_rate_limit_rpm (1..${MAX_RPM})`)
  }
  if (input.maxConcurrency !== undefined && (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > MAX_CONCURRENCY)) {
    throw new Error(`invalid_max_concurrency (1..${MAX_CONCURRENCY})`)
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= now) {
    throw new Error('invalid_expires_at (must be in the future)')
  }
}

/**
 * Mint a key. The returned `token` is the **only** chance to get the plaintext (the UI/CLI must show it on the spot).
 */
export const mintApiKey = (db: Db, input: MintInput): { token: string; key: ApiKey } => {
  const now = Date.now()
  assertMintInput(input, now)

  // A keyId collision has probability 2^-48; on a real collision retry rather than throwing the primary-key conflict at the caller.
  let keyId = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = randomBytes(6).toString('hex')
    const exists = db.select({ id: schema.apiKey.id }).from(schema.apiKey).where(eq(schema.apiKey.id, candidate)).all().length > 0
    if (!exists) {
      keyId = candidate
      break
    }
  }
  if (keyId === '') throw new Error('key_id_collision')

  // No `_` in the secret (it is the separator, see the comment above TOKEN_RE): base64url carries `_` about
  // half the time, so redraw until it is clean -- the length stays 43 and the entropy stays around 256 bits, a negligible cost.
  let secret = randomBytes(32).toString('base64url')
  while (secret.includes('_')) secret = randomBytes(32).toString('base64url')
  db.insert(schema.apiKey)
    .values({
      id: keyId,
      name: input.name.trim(),
      keyHash: digest(secret),
      scopes: JSON.stringify(input.scopes),
      scopeServices: JSON.stringify(input.scopeServices),
      quotaRunsDay: input.quotaRunsDay ?? null,
      rateLimitRpm: input.rateLimitRpm ?? 60,
      maxConcurrency: input.maxConcurrency ?? 4,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      lastUsedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
    })
    .run()

  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, keyId)).all()[0]
  if (row === undefined) throw new Error('key_insert_failed')
  return { token: `dac_${keyId}_${secret}`, key: toApiKey(row) }
}

/** Verify a key string. On success, refresh lastUsedAt along the way (throttled). */
export const verifyApiKey = (db: Db, token: string | undefined): VerifyResult => {
  if (token === undefined) return { ok: false, reason: 'malformed' }
  const matched = TOKEN_RE.exec(token)
  if (matched === null) return { ok: false, reason: 'malformed' }
  const keyId = matched[1] ?? ''
  const secret = matched[2] ?? ''

  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, keyId)).all()[0]
  if (row === undefined) return { ok: false, reason: 'unknown' }

  const expected = Buffer.from(row.keyHash, 'hex')
  const actual = Buffer.from(digest(secret), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    // The prefix exists but the secret is wrong: the same reason as "the prefix does not exist", leaving no probe.
    return { ok: false, reason: 'unknown' }
  }

  if (row.revokedAt !== null) return { ok: false, reason: 'revoked' }
  const now = Date.now()
  if (row.expiresAt !== null && row.expiresAt <= now) return { ok: false, reason: 'expired' }

  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_THROTTLE_MS) {
    db.update(schema.apiKey).set({ lastUsedAt: now }).where(eq(schema.apiKey.id, keyId)).run()
    return { ok: true, key: toApiKey({ ...row, lastUsedAt: now }) }
  }
  return { ok: true, key: toApiKey(row) }
}

/** Revoking is idempotent: revoking an already-revoked key still returns true (a UI button retry should not error). */
export const revokeApiKey = (db: Db, id: string): boolean => {
  if (!KEY_ID_RE.test(id)) return false
  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, id)).all()[0]
  if (row === undefined) return false
  if (row.revokedAt === null) {
    db.update(schema.apiKey).set({ revokedAt: Date.now() }).where(eq(schema.apiKey.id, id)).run()
  }
  return true
}

/** The fields an edit may change (the secret and the id never do -- an edit must not lock the customer out). */
export interface UpdateKeyInput {
  name?: string
  scopes?: readonly KeyScope[]
  scopeServices?: readonly string[]
  quotaRunsDay?: number | null
  rateLimitRpm?: number
  maxConcurrency?: number
  expiresAt?: number | null
}

/**
 * Edit a key in place. Every provided field passes the same validation as minting; fields that are
 * absent stay as they were, and `keyHash`/`revokedAt`/`createdAt` are never writable through here.
 */
export const updateApiKey = (db: Db, id: string, input: UpdateKeyInput): ApiKey | null => {
  if (!KEY_ID_RE.test(id)) return null
  const existing = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, id)).all()[0]
  if (existing === undefined) return null

  const name = input.name ?? existing.name
  const scopes = input.scopes ?? parseScopes(existing.scopes)
  const scopeServices = input.scopeServices ?? parseList(existing.scopeServices)
  const quotaRunsDay = input.quotaRunsDay !== undefined ? input.quotaRunsDay : existing.quotaRunsDay
  const rateLimitRpm = input.rateLimitRpm ?? existing.rateLimitRpm
  const maxConcurrency = input.maxConcurrency ?? existing.maxConcurrency
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt

  // The mint assertion is the one validation web (a second, looser copy would drift): build a mint
  // input from the merged result and let it judge.
  assertMintInput({ name, scopes, scopeServices, quotaRunsDay, rateLimitRpm, maxConcurrency, expiresAt, createdBy: existing.createdBy }, Date.now())

  db.update(schema.apiKey)
    .set({
      name: name.trim(),
      scopes: JSON.stringify(scopes),
      scopeServices: JSON.stringify(scopeServices),
      quotaRunsDay,
      rateLimitRpm,
      maxConcurrency,
      expiresAt,
    })
    .where(eq(schema.apiKey.id, id))
    .run()

  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, id)).all()[0]
  return row === undefined ? null : toApiKey(row)
}

/** The list never returns plaintext (there is structurally no such field). */
export const listApiKeys = (db: Db): ApiKey[] =>
  db.select().from(schema.apiKey).orderBy(desc(schema.apiKey.createdAt)).all().map(toApiKey)

export const findApiKey = (db: Db, id: string): ApiKey | null => {
  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, id)).all()[0]
  return row === undefined ? null : toApiKey(row)
}

export const hasScope = (key: ApiKey, scope: KeyScope): boolean => key.scopes.includes(scope)

export const allowsService = (key: ApiKey, serviceId: string): boolean =>
  key.scopeServices.includes('*') || key.scopeServices.includes(serviceId)
