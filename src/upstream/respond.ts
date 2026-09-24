/**
 * Respond to interactive questions and approval requests via apiproxy.
 *
 * Wire format (dsh-host-apiproxy, DSH 0.1.1-rc.2):
 *
 *   POST <base>/respond
 *   body:  { type:'client-response', rpcId, result }
 *   reply: HTTP 200 with { accepted:true }
 *          or { accepted:false, reason:'not-pending'|'bad-response' }
 *
 * The rpcId must echo the id of the original `question/requested` /
 * `approval/requested` mux frame. The host routes the response by that id
 * through its pending table — there is no method name in the request.
 *
 * A declined question is expressed as a not-ok result whose error code is
 * 'cancelled' (the host claims the pending entry with outcome 'cancelled');
 * any other not-ok result is rejected with reason 'bad-response'.
 *
 * Note: `respond` is NOT on the rpc whitelist because it uses a different
 * endpoint path (`/respond` not `/<method>`) and does not follow the standard
 * RPC envelope. It is called directly.
 */

import type { UpstreamEndpoint } from './rpc.js'

export interface RpcReceipt {
  accepted: boolean
  reason?: 'not-pending' | 'bad-response'
}

/** The `result` slot of a client-response: an ok answer or a not-ok decline. */
export type RespondResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

/**
 * Send a response to a pending server-request (question or approval).
 *
 * @returns receipt indicating whether the response was accepted.
 *   `accepted: false, reason: 'not-pending'` means someone else already answered.
 */
export async function respond(
  ep: UpstreamEndpoint,
  rpcId: string,
  result: RespondResult,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<RpcReceipt> {
  const url = `${ep.base}/respond`
  const body = JSON.stringify({
    type: 'client-response',
    rpcId,
    result,
  })

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

  // The carrier still answers non-200 for wrong paths / media types.
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`upstream respond: HTTP ${response.status} — ${detail.slice(0, 300)}`)
  }

  const json = await response.json() as { accepted?: boolean; reason?: string }

  if (json.accepted === true) return { accepted: true }
  return {
    accepted: false,
    reason: json.reason === 'not-pending' || json.reason === 'bad-response' ? json.reason : 'not-pending',
  }
}
