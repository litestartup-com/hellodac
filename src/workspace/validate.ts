import type { NoteData } from './notedata.js'

/**
 * Enforces the workspace's own documented rules so an agent cannot quietly
 * violate them. These are checks, not rewrites: a failing write is rejected
 * and rolled back rather than silently "fixed".
 *
 * 债务 E12:业务规则全部外置为 `ValidateRules`(来自 manager.config.yaml 的
 * agent.validate 段)——旧实现把 note-kaka 的窗口/金额/acct 规则硬编码在
 * 代码里,任何新用户都会继承一套不属于自己的治理行为。代码只保留两样:
 * 通用的凭证检查(no-secrets,所有工作区都该有)与规则引擎。
 */

export interface Violation {
  rule: string
  path: string
  detail: string
}

/** 债务 E12:per-agent 治理规则(manager.config.yaml → agent.validate)。 */
export interface ValidateRules {
  /** 治理窗口:「路径(点分)→ 条目上限 + 归档去向」,note-kaka README §3 的外置化。 */
  windows: { path: string; max: number; archive: string }[]
  /** trade 数据禁金额字段(RULE.md §7 的外置化)。 */
  forbidAmountFields: boolean
  /** acct.flow 只保留最近 N 个月(README §2.5 的外置化);null = 不检查。 */
  acctFlowMaxAgeMonths: number | null
}

/** 无业务规则的默认值:只做通用的凭证检查。 */
export const DEFAULT_RULES: ValidateRules = { windows: [], forbidAmountFields: false, acctFlowMaxAgeMonths: null }

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null)

const dig = (data: NoteData, path: string[]): unknown => {
  let current: unknown = data
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

const checkWindows = (data: NoteData, windows: ValidateRules['windows']): Violation[] => {
  const out: Violation[] = []
  for (const { path, max, archive } of windows) {
    const segments = path.split('.')
    const list = asArray(dig(data, segments))
    if (list === null) continue
    if (list.length > max) {
      out.push({
        rule: 'governance-window',
        path,
        detail: `${list.length} entries exceeds the documented cap of ${max}; archive the oldest to ${archive} first`,
      })
    }
  }
  return out
}

/**
 * Percentages only, never amounts (`cost` and `price` are legitimate per-share
 * quotes; what must never appear is anything that reveals position size).
 */
const MONEY_FIELDS = /^(amount|amt|money|cash_?value|value|total|shares|qty|quantity|金额|市值|数量|股数|成本额)$/i

const checkTradePrivacy = (data: NoteData): Violation[] => {
  const out: Violation[] = []
  const trade = dig(data, ['trade'])
  if (trade === null || typeof trade !== 'object') return out

  const scan = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => scan(item, `${path}[${i}]`))
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (MONEY_FIELDS.test(key)) {
        out.push({
          rule: 'no-amounts',
          path: `${path}.${key}`,
          detail: 'trade data records percentages only, never amounts',
        })
      }
      scan(value, `${path}.${key}`)
    }
  }

  scan(trade, 'trade')
  return out
}

/**
 * README §4: no password, token, API key or server credential may appear in a
 * data file. Patterns are deliberately narrow -- a false positive blocks a
 * legitimate write, which is far more annoying than a missed exotic format.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'aws access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'url with inline credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i },
  { name: 'labelled credential', re: /\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S{8,}/i },
]

const checkSecrets = (data: NoteData): Violation[] => {
  const out: Violation[] = []
  const scan = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(node)) {
          out.push({
            rule: 'no-secrets',
            path,
            // The offending value is never echoed back -- that would copy the
            // secret into manager's logs and HTTP responses.
            detail: `looks like a ${name}; credentials must not appear in data files (note-data/README.md §4)`,
          })
        }
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => scan(item, `${path}[${i}]`))
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) scan(value, `${path}.${key}`)
  }
  scan(data, '$')
  return out
}

/** acct.flow keeps the current and previous months only(阈值由规则外置)。 */
const checkAcctFlow = (data: NoteData, maxAgeMonths: number, now: Date): Violation[] => {
  const flow = asArray(dig(data, ['acct', 'flow']))
  if (flow === null) return []

  const allowed = new Set<string>()
  for (let back = 0; back <= maxAgeMonths; back += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1)
    allowed.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    allowed.add(String(d.getMonth() + 1).padStart(2, '0'))
  }

  const out: Violation[] = []
  flow.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object') return
    const d = (entry as { d?: unknown }).d
    if (typeof d !== 'string') return
    // Placeholder rows are the documented way to show "no data yet", and
    // acct.js currently ships exactly that. Only a genuinely date-shaped
    // value can be stale.
    const match = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(d.trim())
    if (match === null) return
    const month = match[1] === undefined ? (match[2] ?? '').padStart(2, '0') : `${match[1]}-${(match[2] ?? '').padStart(2, '0')}`
    if (!allowed.has(month)) {
      out.push({
        rule: 'governance-window',
        path: `acct.flow[${i}]`,
        detail: `entry dated "${d}" is older than the configured ${maxAgeMonths + 1}-month window; archive it first`,
      })
    }
  })
  return out
}

export interface ValidateOptions {
  now?: Date
  /** 债务 E12:per-agent 规则;缺省 = DEFAULT_RULES(只做通用凭证检查)。 */
  rules?: ValidateRules
}

export const validateNoteData = (data: NoteData, options: ValidateOptions = {}): Violation[] => {
  const rules = options.rules ?? DEFAULT_RULES
  return [
    ...checkWindows(data, rules.windows),
    ...(rules.forbidAmountFields ? checkTradePrivacy(data) : []),
    ...checkSecrets(data),
    ...(rules.acctFlowMaxAgeMonths === null ? [] : checkAcctFlow(data, rules.acctFlowMaxAgeMonths, options.now ?? new Date())),
  ]
}
