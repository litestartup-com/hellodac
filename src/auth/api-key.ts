/**
 * 对外 API 钥匙（设计稿：内部设计库 `manager/topics/public-api.md` §5 / §11）。
 *
 * 与 session / agent token 同一套思路：明文**只在创建时回显一次**，库里只存 sha256。
 * 区别是钥匙属于机器调用方，因此额外带作用域、服务范围与配额——这三个在本模块只做
 * 存取与判定，真正的强制点在 public-api 层（门面）。
 *
 * 校验结果五态分明，但刻意让「未知 keyId」与「前缀对、secret 错」返回同一个
 * reason（unknown）：否则调用方可以拿返回差异探测哪些 keyId 真实存在。
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
  /** 允许进入的服务 id；['*'] = 全部。与坐席 public 标志取交集（双门）。 */
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
const TOKEN_RE = /^dac_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/
/** 每次调用都写 lastUsedAt = 白烧写入；一分钟一次足够界面显示"最近使用"。 */
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

/** 未知 scope 一律丢弃：库里被手改出奇怪值时，宁可不授权也不放宽。 */
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
 * 签发一把钥匙。返回的 `token` 是**唯一一次**拿到明文的机会（UI/CLI 必须当场展示）。
 */
export const mintApiKey = (db: Db, input: MintInput): { token: string; key: ApiKey } => {
  const now = Date.now()
  assertMintInput(input, now)

  // keyId 撞车概率 2^-48；真撞上时重试，而不是把主键冲突抛给调用方。
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

  const secret = randomBytes(32).toString('base64url')
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

/** 校验钥匙串。成功时顺带（节流地）刷新 lastUsedAt。 */
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
    // 前缀存在但 secret 错：与「前缀不存在」同一原因，不留探测口。
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

/** 吊销是幂等的：已吊销再吊销仍返回 true（界面按钮重试不该报错）。 */
export const revokeApiKey = (db: Db, id: string): boolean => {
  if (!KEY_ID_RE.test(id)) return false
  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, id)).all()[0]
  if (row === undefined) return false
  if (row.revokedAt === null) {
    db.update(schema.apiKey).set({ revokedAt: Date.now() }).where(eq(schema.apiKey.id, id)).run()
  }
  return true
}

/** 列表永不返回明文（结构上就没有这个字段）。 */
export const listApiKeys = (db: Db): ApiKey[] =>
  db.select().from(schema.apiKey).orderBy(desc(schema.apiKey.createdAt)).all().map(toApiKey)

export const findApiKey = (db: Db, id: string): ApiKey | null => {
  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, id)).all()[0]
  return row === undefined ? null : toApiKey(row)
}

export const hasScope = (key: ApiKey, scope: KeyScope): boolean => key.scopes.includes(scope)

export const allowsService = (key: ApiKey, serviceId: string): boolean =>
  key.scopeServices.includes('*') || key.scopeServices.includes(serviceId)
