/**
 * "Does this key actually work?" -- the check the key surface never had.
 *
 * The gap this closes: an operator minted a key, copied the token, and had no way to know whether it
 * worked until the customer reported a 401. Everything needed to answer the question existed; nothing
 * asked it.
 *
 * Two deliberate choices:
 *
 * - **The probe goes out through the outward door** (`http://<listener>/v1/...` with the key), not
 *   through the manager's internals. Checking the database would only prove the row exists, which is
 *   the one thing that was never in doubt: the failure modes worth catching are a facade that is not
 *   listening, a key scoped to a service the facade refuses, and a listener bound somewhere the
 *   customer cannot reach.
 * - **Read-only, and only with the token in hand.** Nothing here can spend money or quota: the calls
 *   are `GET /v1/services` and `GET /v1/usage`, the two the key's own default scopes allow. The token
 *   is never stored -- the manager keeps only hashes by design -- so the check runs on the plaintext
 *   the operator still has, which is why the UI offers it right after issuing a key and says plainly
 *   that it cannot be repeated later.
 */
import { allowsService, hasScope, verifyApiKey, type ApiKey } from '../auth/api-key.js'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'

export interface ProbeStep {
  /** The outward path that was called. */
  path: string
  ok: boolean
  status: number
  /** What it proves, or why it failed -- written for an operator, not for a log. */
  detail: string
}

export interface KeyProbeResult {
  ok: boolean
  /** Where the call went (what the customer will be told to call). */
  target: string
  steps: ProbeStep[]
  /** Non-fatal notes: a missing scope only removes the ability to answer that one question. */
  notes: string[]
}

const call = async (url: string, token: string): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

const errorCodeOf = (body: unknown): string => {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return typeof record['error'] === 'string' ? record['error'] : ''
}

const detailOf = (body: unknown): string => {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return typeof record['detail'] === 'string' ? record['detail'] : ''
}

export const probeApiKey = async (deps: {
  db: Db
  config: AppConfig
  token: string
  /** Whether the facade reports itself as listening (the listener keeps this state in-process). */
  listener: { status: string; host: string; port: number; detail: string | null }
}): Promise<KeyProbeResult> => {
  const where = `http://${deps.listener.host}:${deps.listener.port}`
  const steps: ProbeStep[] = []
  const notes: string[] = []

  if (deps.listener.status === 'disabled') {
    return {
      ok: false,
      target: where,
      steps: [],
      notes: ['the outward listener is disabled in this deployment (public_api.enabled=false), so a key cannot be used at all'],
    }
  }
  if (deps.listener.status !== 'listening') {
    return {
      ok: false,
      target: where,
      steps: [],
      notes: [`the outward listener is not listening (${deps.listener.detail ?? deps.listener.status}); bring it up before handing this key out`],
    }
  }

  // Step 1: is the door answering at all? Unauthenticated on purpose -- this separates 'the facade is
  // down' from 'the key is wrong', which are two very different phone calls.
  try {
    const { status } = await call(`${where}/v1/health`, deps.token)
    steps.push({
      path: 'GET /v1/health',
      ok: status === 200,
      status,
      detail: status === 200 ? 'the outward door answers' : `unexpected status ${status}`,
    })
  } catch (error) {
    return {
      ok: false,
      target: where,
      steps: [{ path: 'GET /v1/health', ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) }],
      notes: ['nothing answered at the outward address -- check that the facade is running and reachable'],
    }
  }

  // What this key claims to be allowed, decided by the manager's own verifier (the answer the outward
  // side will give) -- so the steps below are only attempted where they can succeed.
  const verified = verifyApiKey(deps.db, deps.token)
  if (!verified.ok) {
    return {
      ok: false,
      target: where,
      steps: [...steps, { path: '(key check)', ok: false, status: 401, detail: `this key is ${verified.reason}` }],
      notes: [],
    }
  }
  const key: ApiKey = verified.key

  const services = (deps.config.services ?? []).filter((service) => allowsService(key, service.id))

  if (hasScope(key, 'services:read')) {
    const { status, body } = await call(`${where}/v1/services`, deps.token)
    const visible = body !== null && typeof body === 'object' && Array.isArray((body as { services?: unknown }).services)
      ? ((body as { services: Array<{ id?: unknown }> }).services.map((s) => String(s.id ?? '')).filter((id) => id !== ''))
      : []
    steps.push({
      path: 'GET /v1/services',
      ok: status === 200,
      status,
      detail: status === 200
        ? visible.length === 0
          ? 'accepted, but this key can reach no service (check its service scope)'
          : `accepted; this key can reach: ${visible.join(', ')}`
        : `${status} ${errorCodeOf(body)} ${detailOf(body)}`.trim(),
    })
  } else {
    notes.push('this key has no services:read scope, so "which services can it reach" could not be checked')
  }

  if (hasScope(key, 'usage:read')) {
    const { status, body } = await call(`${where}/v1/usage`, deps.token)
    const today = body !== null && typeof body === 'object' ? (body as { today?: { used?: unknown; limit?: unknown } }).today : undefined
    steps.push({
      path: 'GET /v1/usage',
      ok: status === 200,
      status,
      detail: status === 200
        ? `accepted; today ${String(today?.used ?? '?')}${today?.limit === null || today?.limit === undefined ? '' : `/${String(today.limit)}`} calls used`
        : `${status} ${errorCodeOf(body)} ${detailOf(body)}`.trim(),
    })
  } else {
    notes.push('this key has no usage:read scope, so its quota could not be read back')
  }

  if (services.length === 0) {
    notes.push('this key is scoped to no configured service: it will be accepted but can never start a conversation')
  }
  const ok = steps.every((step) => step.ok)
  return { ok, target: where, steps, notes }
}
