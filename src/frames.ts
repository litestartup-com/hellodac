/**
 * The manager's domain frame vocabulary (frames + usage + history events).
 *
 * These shapes are what the whole product speaks: the runner bills them, the chat relay
 * publishes them, the frontend renders them. They originated as the dsh-api-gateway wire
 * format and kept their names when the gateway driver was retired (2026-10, DSH-FACTS §15:
 * facade 0.2.x dropped the gateway's session REST surface, leaving the frozen apiproxy
 * contract as the only live path). Today they are produced by `upstream/translate.ts`
 * (facade mux frames → domain frames) and by the SessionDriver plugs; nothing here is
 * gateway-specific any more, and the `Gateway*` names are kept only to avoid a rename
 * churn across the codebase and the frontend's frame contract.
 *
 * `HistoryEvent` is one mapped event of a session's durable log (the same shape the
 * facade's `session.history` returns after translation).
 */

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface GatewayFrame {
  kind: string
  seq: number
  [key: string]: unknown
}

/** One mapped event from the session's durable log (session.history events, post-translation). */
export interface HistoryEvent {
  kind: string
  seq: number
  [key: string]: unknown
}

const OPTIONAL_USAGE_KEYS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/**
 * Mirrors the upstream's own normalisation so a partial or absent accounting
 * block never becomes a bogus zero-cost record.
 */
export const normalizeUsage = (usage: unknown): TokenUsage | null => {
  if (usage === null || typeof usage !== 'object') return null
  const source = usage as Record<string, unknown>
  const count = (key: string): number | undefined => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const inputTokens = count('inputTokens')
  const outputTokens = count('outputTokens')
  if (inputTokens === undefined && outputTokens === undefined) return null
  const out: TokenUsage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
  for (const key of OPTIONAL_USAGE_KEYS) {
    const value = count(key)
    if (value !== undefined) out[key] = value
  }
  return out
}

export const sumUsage = (total: TokenUsage | null, step: TokenUsage | null): TokenUsage | null => {
  if (step === null) return total
  if (total === null) return { ...step }
  const out: TokenUsage = {
    inputTokens: total.inputTokens + step.inputTokens,
    outputTokens: total.outputTokens + step.outputTokens,
  }
  for (const key of OPTIONAL_USAGE_KEYS) {
    if (total[key] === undefined && step[key] === undefined) continue
    out[key] = (total[key] ?? 0) + (step[key] ?? 0)
  }
  return out
}
