/**
 * `npm run key -- …` —— 对外 API 钥匙的运维入口（设计稿 §5）。
 *
 * 安全默认值向"限制"一侧倒：默认只读 scope、必须显式指定服务（或显式 `--all-services`）、
 * 默认带日配额。理由：发钥匙是给人用的，默认值决定了最坏情况——一条命令手滑产生的
 * 应该是"只能读、只能进一个服务、每天 200 次"的钥匙，而不是一把万能钥匙。
 *
 * 明文只在 create 时打印一次；list 永不打印（结构上就没有这个字段）。
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { openDb, type Db } from '../db/index.js'
import { KEY_SCOPES, listApiKeys, mintApiKey, revokeApiKey, type ApiKey, type KeyScope } from '../auth/api-key.js'
import { recordAudit } from '../audit.js'

export interface CreateOptions {
  name: string
  scopeServices: string[]
  scopes: KeyScope[]
  quotaRunsDay: number | null
  rateLimitRpm: number
  maxConcurrency: number
  expiresAt: number | null
}

export type ParsedArgs =
  | { command: 'create'; options: CreateOptions }
  | { command: 'list' }
  | { command: 'revoke'; id: string }
  | { command: 'help' }

export const HELP = `DAC API keys — outward API credentials

  npm run key -- create --name <name> (--services a,b | --all-services) [options]
  npm run key -- list
  npm run key -- revoke <keyId>

create options
  --name <name>          who or what this key is for (required)
  --services a,b         services this key may call (required unless --all-services)
  --all-services         allow every service (["*"])
  --scopes a,b           default: ${['services:read', 'usage:read'].join(',')}
                         available: ${KEY_SCOPES.join(', ')}
  --quota <n|none>       runs per local day (default 200; "none" = unlimited)
  --rpm <n>              requests per minute (default 60)
  --concurrency <n>      in-flight runs (default 4)
  --expires <YYYY-MM-DD> key stops working after this date (default: never)

The secret is printed once and stored only as sha256 — copy it then.`

const DAY_MS = 86_400_000

const readFlag = (argv: string[], flag: string): string | null => {
  const index = argv.indexOf(flag)
  if (index === -1) return null
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? null : value
}

const splitList = (raw: string): string[] => raw.split(',').map((v) => v.trim()).filter((v) => v !== '')

export const parseKeyArgs = (argv: string[]): ParsedArgs | { error: string } => {
  const command = argv[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') return { command: 'help' }
  if (command === 'list') return { command: 'list' }
  if (command === 'revoke') {
    const id = argv[1]
    if (id === undefined || id === '' || id.startsWith('--')) return { error: 'revoke needs a key id (see: npm run key -- list)' }
    return { command: 'revoke', id }
  }
  if (command !== 'create') return { error: `unknown command "${command}" (try: npm run key -- help)` }

  const name = readFlag(argv, '--name')
  if (name === null || name.trim() === '') return { error: 'create needs --name "<who or what>"' }

  const allServices = argv.includes('--all-services')
  const servicesFlag = readFlag(argv, '--services')
  if (!allServices && (servicesFlag === null || splitList(servicesFlag).length === 0)) {
    return { error: 'create needs --services a,b (or --all-services to allow every service)' }
  }
  const scopeServices = allServices ? ['*'] : splitList(servicesFlag ?? '')

  const scopesFlag = readFlag(argv, '--scopes')
  const scopes = scopesFlag === null ? (['services:read', 'usage:read'] as KeyScope[]) : splitList(scopesFlag)
  const unknown = scopes.filter((s) => !(KEY_SCOPES as readonly string[]).includes(s))
  if (unknown.length > 0) return { error: `unknown scope: ${unknown.join(', ')} (available: ${KEY_SCOPES.join(', ')})` }

  const quotaFlag = readFlag(argv, '--quota')
  let quotaRunsDay: number | null = 200
  if (quotaFlag === 'none') quotaRunsDay = null
  else if (quotaFlag !== null) {
    const n = Number(quotaFlag)
    if (!Number.isInteger(n) || n < 1) return { error: `--quota must be a positive integer or "none" (got ${quotaFlag})` }
    quotaRunsDay = n
  }

  const numeric = (flag: string, fallback: number): number | { error: string } => {
    const raw = readFlag(argv, flag)
    if (raw === null) return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) return { error: `${flag} must be a positive integer (got ${raw})` }
    return n
  }
  const rpm = numeric('--rpm', 60)
  if (typeof rpm === 'object') return rpm
  const concurrency = numeric('--concurrency', 4)
  if (typeof concurrency === 'object') return concurrency

  const expiresFlag = readFlag(argv, '--expires')
  let expiresAt: number | null = null
  if (expiresFlag !== null) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(expiresFlag) ? new Date(`${expiresFlag}T23:59:59`).getTime() : Number.NaN
    if (Number.isNaN(parsed)) return { error: `--expires must be YYYY-MM-DD (got ${expiresFlag})` }
    if (parsed <= Date.now()) return { error: `--expires ${expiresFlag} is in the past` }
    expiresAt = parsed
  }

  return {
    command: 'create',
    options: { name, scopeServices, scopes: scopes as KeyScope[], quotaRunsDay, rateLimitRpm: rpm, maxConcurrency: concurrency, expiresAt },
  }
}

/** 创建 + 落审计。返回明文 token（调用方负责打印一次）。 */
export const createKey = (db: Db, options: CreateOptions): { token: string; key: ApiKey } => {
  const { token, key } = mintApiKey(db, { ...options, createdBy: 'cli' })
  recordAudit(db, {
    actor: 'cli',
    kind: 'api_key_created',
    detail: `key ${key.id} "${key.name}" services=[${key.scopeServices.join(', ')}] scopes=[${key.scopes.join(', ')}] quota=${key.quotaRunsDay ?? 'none'}/day`,
  })
  return { token, key }
}

export const revokeKeyCli = (db: Db, id: string): boolean => {
  const ok = revokeApiKey(db, id)
  if (ok) recordAudit(db, { actor: 'cli', kind: 'api_key_revoked', detail: `key ${id} revoked` })
  return ok
}

const stamp = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '))
const relative = (ms: number | null, now: number): string => {
  if (ms === null) return 'never'
  const days = Math.floor((now - ms) / DAY_MS)
  return days <= 0 ? 'today' : `${days}d ago`
}

export const renderKeyList = (keys: ApiKey[], now: number): string => {
  if (keys.length === 0) return 'no keys yet — create one with: npm run key -- create --name "..." --services <service>'
  const lines = keys.map((key) => {
    const state = key.revokedAt !== null ? `revoked ${stamp(key.revokedAt)}` : key.expiresAt !== null && key.expiresAt <= now ? 'expired' : 'active'
    const quota = key.quotaRunsDay === null ? 'unlimited' : `${key.quotaRunsDay}/day`
    return [
      `  ${key.id}  ${state.padEnd(12)} ${key.name}`,
      `      services: ${key.scopeServices.join(', ')}  ·  scopes: ${key.scopes.join(', ')}`,
      `      limits: ${quota} · ${key.rateLimitRpm}/min · ${key.maxConcurrency} concurrent  ·  created ${stamp(key.createdAt)}  ·  last used ${relative(key.lastUsedAt, now)}`,
    ].join('\n')
  })
  return lines.join('\n')
}

const openCliDb = (): { db: Db } => {
  const config = loadConfig()
  return { db: openDb(config.databasePath).db }
}

const main = (): void => {
  const parsed = parseKeyArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(`✗ ${parsed.error}`)
    console.error(`\n${HELP}`)
    process.exit(2)
  }

  if (parsed.command === 'help') {
    console.log(HELP)
    return
  }

  const { db } = openCliDb()
  if (parsed.command === 'list') {
    console.log(renderKeyList(listApiKeys(db), Date.now()))
    return
  }
  if (parsed.command === 'revoke') {
    const ok = revokeKeyCli(db, parsed.id)
    console.log(ok ? `✓ revoked ${parsed.id} (the key stops working immediately; its audit trail stays)` : `✗ unknown key ${parsed.id}`)
    process.exit(ok ? 0 : 1)
  }

  const { token, key } = createKey(db, parsed.options)
  const quota = key.quotaRunsDay === null ? 'unlimited' : `${key.quotaRunsDay} runs/day`
  console.log(
    [
      '✓ key created — copy it now, it is never shown again:',
      '',
      `    ${token}`,
      '',
      `  id       : ${key.id}`,
      `  name     : ${key.name}`,
      `  services : ${key.scopeServices.join(', ')}`,
      `  scopes   : ${key.scopes.join(', ')}`,
      `  limits   : ${quota} · ${key.rateLimitRpm} req/min · ${key.maxConcurrency} concurrent`,
      `  expires  : ${key.expiresAt === null ? 'never' : stamp(key.expiresAt)}`,
      '',
      `  try it   : curl -H "Authorization: Bearer <token>" http://127.0.0.1:${loadConfig().publicApi?.port ?? 8081}/v1/services`,
    ].join('\n'),
  )
}

// 只在被直接执行时运行：被测试 import 时绝不能有副作用（同 cli/service.ts 的纪律）。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
