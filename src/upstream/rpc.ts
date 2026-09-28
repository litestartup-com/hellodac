/**
 * Unary RPC caller for the DSH apiproxy contract.
 *
 * Debt E16: the notes verifying the wire format moved to the design library's fact card
 * dsh-facts.md §9 (RPC section); the points: business success is `result.ok` alone, not the
 * HTTP status code; the envelope method must match the path; the allowlist fails closed.
 */

import { z } from 'zod'

export interface UpstreamEndpoint {
  /** e.g. 'http://127.0.0.1:3080/api' */
  base: string
  /** Non-empty when the endpoint requires auth (Scheme B / cross-machine). */
  key: string
}

// ---- whitelist ----

/**
 * Methods the manager is allowed to call through apiproxy.
 * Everything else is rejected locally — fail-closed, no exceptions.
 */
const WHITELIST = new Set([
  // session lifecycle
  'session.list',
  'session.create',
  'session.history',
  'session.prompt',
  'session.cancel',
  'session.rename',
  'session.fork',
  'session.updateQueue',
  'session.attachment',
  // model
  'session.models',
  'session.selectModel',
  // host
  'host.describe',
])

/** Exported for testing: the whitelist is the security boundary. */
export const isMethodAllowed = (method: string): boolean => WHITELIST.has(method)

// ---- RPC types ----

export interface RpcOk<T = unknown> {
  id: string
  result: { ok: true; value: T }
}

export interface RpcError {
  code: string
  message: string
}

export class UpstreamError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
  }
}

// ---- wire schema (Debt E8: a discriminated zod schema replaces hand-flattened typeof checks) ----

/**
 * The discriminated schema for server-response (wire shape in the module header; verified against DSH 0.1.1-rc.2).
 * ok:false with no error branch = malformed upstream reply -- fail loud, no guessing at the reason.
 */
const rpcEnvelopeSchema = z.object({
  type: z.literal('server-response'),
  rpcId: z.string().optional(),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
    }),
  ]),
})

// ---- RPC call ----

let rpcSeq = 0

/**
 * One apiproxy RPC call.
 *
 * The caller must check `result.ok` — HTTP is always 200. An `ok: false`
 * response throws `UpstreamError` with the upstream's `code` and `message`.
 *
 * @throws {UpstreamError} when result.ok is false
 * @throws {Error} on network / timeout / whitelist violations
 */
export async function rpc<T = unknown>(
  ep: UpstreamEndpoint,
  method: string,
  params: Record<string, unknown> = {},
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<RpcOk<T>> {
  if (!isMethodAllowed(method)) {
    throw new Error(`upstream: method "${method}" is not on the whitelist — rejected locally`)
  }

  const id = `upstream-${Date.now()}-${++rpcSeq}`
  const url = `${ep.base}/${method}`
  const body = JSON.stringify({ type: 'client-request', rpcId: id, method, payload: params })

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (ep.key !== '') headers['x-api-key'] = ep.key

  const signal = opts?.timeoutMs !== undefined
    ? AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), ...(opts?.signal ? [opts.signal] : [])])
    : opts?.signal

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: signal ?? null,
  })

  // apiproxy always returns 200 for business outcomes; a non-200 means we hit
  // the carrier layer (unknown path 404, non-JSON 415/400, trust fence, or a
  // handler crash 500).
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`upstream ${method}: HTTP ${response.status} — ${detail.slice(0, 300)}`)
  }

  const raw: unknown = await response.json()

  const parsed = rpcEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    // Debt E8: the discriminated schema catches it in one place -- not server-response /
    // missing result / ok:false with no error branch all fail loud, no guessing at upstream intent.
    throw new Error(`upstream ${method}: response missing "result" field or malformed server-response`)
  }
  const json = parsed.data

  if (!json.result.ok) {
    throw new UpstreamError(json.result.error.code, `upstream ${method}: ${json.result.error.message}`)
  }

  return { id: json.rpcId ?? id, result: { ok: true, value: json.result.value as T } }
}
