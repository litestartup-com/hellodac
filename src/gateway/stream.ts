/**
 * SSE consumer for a gateway session stream.
 *
 * 债务 E16:wire 格式核实笔记已迁设计库事实卡 dsh-facts.md §9(gateway SSE 段);
 * 要点:无 event: 行(帧类型在 JSON 的 kind)、hello 携带全部历史(计费必须
 * 忽略)、turn_end 后流不自行关闭(停止是调用方的责任)。
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

const OPTIONAL_USAGE_KEYS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/**
 * Mirrors the gateway's own normalisation so a partial or absent accounting
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

/** Extracts the JSON from one SSE block, ignoring `retry:`, `event:` and comments. */
const parseBlock = (block: string): GatewayFrame | null => {
  const payload = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (payload === '') return null
  try {
    const parsed = JSON.parse(payload) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const frame = parsed as Record<string, unknown>
    if (typeof frame.kind !== 'string') return null
    return { ...frame, kind: frame.kind, seq: typeof frame.seq === 'number' ? frame.seq : 0 }
  } catch {
    // A truncated or malformed frame must not kill the run; the caller decides
    // what to do when turn_end never arrives.
    return null
  }
}

export interface StreamOptions {
  headers: Record<string, string>
  signal: AbortSignal
}

/**
 * Yields frames until the server closes the stream or the signal aborts.
 *
 * The caller must break out of the loop itself (typically on `turn_end`) and
 * abort the signal, which is what actually closes the HTTP connection.
 */
export const streamFrames = async function* (
  url: string,
  options: StreamOptions,
): AsyncGenerator<GatewayFrame, void, undefined> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { ...options.headers, accept: 'text/event-stream' },
    signal: options.signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`stream responded ${response.status}: ${detail.slice(0, 300)}`)
  }
  if (response.body === null) throw new Error('stream response had no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Normalise CRLF so a block boundary is always exactly '\n\n'.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary === -1) break
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = parseBlock(block)
        if (frame !== null) yield frame
      }
    }
  } finally {
    // Releasing the lock lets the abort actually tear the socket down.
    reader.cancel().catch(() => undefined)
  }
}
