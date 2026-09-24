import type { ResolvedEndpoint } from '../config.js'

/**
 * The only place that talks to dsh-api-gateway.
 *
 * manager is a server-side client of the gateway's REST/SSE surface -- it does
 * NOT proxy DSH's own web UI. That UI runs typert @Remote over a WebSocket
 * upgrade and its bundle assumes a same-origin root path, so a generic reverse
 * proxy cannot work (DESIGN.md fact 16). The gateway exists precisely for this.
 *
 * Routes verified against dsh-api-gateway/src/index.ts:623-631.
 */

export interface GatewayHealth {
  status: string
  enabled: boolean
  sessions: number
  apiKeySet: boolean
}

export interface CreatedSession {
  sessionId: string
  status: string
  provider: string | null
  model: string | null
  cwd: string | null
  workspace: unknown
}

export interface CreateSessionInput {
  /** Becomes the session's write boundary (fact 1). Always pass the agent workspace. */
  cwd?: string
  provider?: string
  model?: string
  maxTokens?: number
  workspace?: string
}

export interface SentMessage {
  ok: boolean
  sessionId: string
  messageId: string
  status: string
}

/**
 * One answer to one interactive question, in the shape the gateway requires.
 *
 * `selected` carries option labels rather than indexes, because that is what the
 * tool hands back to the model; `custom` is the free-text answer, which is the
 * only thing a question with no options can be answered with.
 */
export interface QuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

export class GatewayError extends Error {  constructor(
    readonly endpointId: string,
    readonly status: number,
    readonly detail: string,
    /**
     * The gateway's machine-readable `error` field, when the body carried one.
     *
     * Needed because the difference between "this session fell out of memory,
     * adopt it and retry" and "this session never existed" is exactly this
     * string, and both arrive as a 404.
     */
    readonly code: string | null = null,
  ) {
    super(`gateway ${endpointId} responded ${status}: ${detail}`)
    this.name = 'GatewayError'
  }
}

/** A live session was expected but the gateway no longer holds one. */
export const isSessionNotFound = (error: unknown): boolean =>
  error instanceof GatewayError && error.status === 404 && error.code === 'session_not_found'

/** `allowAdopt` is off, so a cold session can never be continued again. */
export const isAdoptDisabled = (error: unknown): boolean =>
  error instanceof GatewayError && error.status === 403 && error.code === 'adopt_disabled'

const DEFAULT_TIMEOUT_MS = 20_000 // 债务 E13:单次网关 HTTP 请求超时(勿与 runner 的回合超时混淆)

/** One mapped event from the gateway's durable log. See gateway events.ts. */
export interface HistoryEvent {
  kind: string
  seq: number
  [key: string]: unknown
}

export interface SessionHistory {
  sessionId: string
  /** False when the session is cold: readable, but not yet able to take a turn. */
  adopted: boolean
  header: { id?: string; title?: string | null; cwd?: string | null } | null
  events: HistoryEvent[]
}

export interface ReleasedSession {
  ok: boolean
  sessionId: string
  /** False when the gateway held no such session, i.e. the slot was already free. */
  released: boolean
  /**
   * Whether the gateway disposed the underlying agent.
   *
   * False for a session the gateway was only co-driving (a DSH GUI session it
   * adopted `live`): releasing stops it tracking the session and nothing more.
   */
  disposed: boolean
  mode?: string
  /** Always true. The transcript is durable and outlives the slot. */
  historyRetained: boolean
}

export interface AdoptedSession {
  sessionId: string
  mode: string
  status: string
  provider: string | null
  model: string | null
  cwd: string | null
  history: HistoryEvent[]
}

export class GatewayClient {
  readonly id: string
  private readonly base: string
  private readonly key: string

  constructor(endpoint: ResolvedEndpoint) {
    this.id = endpoint.id
    this.base = `${endpoint.url}${endpoint.prefix}`
    this.key = endpoint.key
  }

  /**
   * Header-only auth. The key is read from the environment at boot and never
   * leaves the server process -- browsers only ever see manager's own cookie.
   */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'X-API-Key': this.key, ...extra }
  }

  streamUrl(sessionId: string): string {
    return `${this.base}/sessions/${encodeURIComponent(sessionId)}/stream`
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    // Every outbound call is bounded. A wedged DSH must degrade into an error,
    // never into a manager request that hangs forever.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        let code: string | null = null
        try {
          const parsed = JSON.parse(text) as { error?: unknown }
          if (typeof parsed.error === 'string') code = parsed.error
        } catch {
          // Not every failure body is JSON; the status and text still stand.
        }
        throw new GatewayError(this.id, response.status, text.slice(0, 500), code)
      }
      return (text === '' ? {} : JSON.parse(text)) as T
    } catch (error) {
      if (error instanceof GatewayError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GatewayError(this.id, 504, `timed out after ${timeoutMs}ms`)
      }
      throw new GatewayError(this.id, 0, error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }
  }

  health(timeoutMs = 5_000): Promise<GatewayHealth> {
    return this.request<GatewayHealth>('GET', '/health', undefined, timeoutMs)
  }

  createSession(input: CreateSessionInput): Promise<CreatedSession> {
    // No sandboxMode parameter exists on POST /sessions today, so the effective
    // mode comes from the DSH profile default (TECH.md §4.3 gap one). The write
    // boundary is still per-session via cwd, so the security model holds.
    return this.request<CreatedSession>('POST', '/sessions', input, 30_000)
  }

  /**
   * The field is `content`, not `text`.
   *
   * Verified against dsh-api-gateway/src/index.ts:780-782, which accepts a
   * non-empty string or a non-empty array of content blocks and answers 400 for
   * anything else. An earlier version of this client sent `{ text }`, which the
   * gateway would have rejected outright.
   */
  sendMessage(sessionId: string, content: string): Promise<SentMessage> {
    return this.request<SentMessage>('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { content })
  }

  /**
   * The transcript of a session, live or cold.
   *
   * The only session route that does NOT require the gateway to still hold the
   * session in memory: it reads the durable snapshot (gateway index.ts:740-749).
   * That is what makes it possible to show an old conversation without waking it
   * up, and therefore without consuming a slot in the gateway's maxSessions.
   */
  history(sessionId: string): Promise<SessionHistory> {
    return this.request<SessionHistory>('GET', `/sessions/${encodeURIComponent(sessionId)}/history`)
  }

  /**
   * Brings a cold session back into memory so it can be continued.
   *
   * The gateway keeps sessions in an in-memory map, so a DSH restart or its
   * maxSessions cap silently turns a session cold. Sending to a cold session
   * answers 404 `session_not_found`; this is the only way back.
   *
   * Refused with 403 `adopt_disabled` when the gateway has `allowAdopt` off, in
   * which case the conversation is readable but permanently unable to continue.
   */
  adopt(sessionId: string): Promise<AdoptedSession> {
    return this.request<AdoptedSession>('POST', `/sessions/${encodeURIComponent(sessionId)}/adopt`, undefined, 30_000)
  }

  /** Stops the turn in flight, leaving the session live and continuable. */
  cancel(sessionId: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/cancel`)
  }

  /**
   * Answers an interactive question the agent is blocked on.
   *
   * Only reaches a gateway configured with `questions: 'gateway'`; anywhere else
   * the question went to that deployment's own UI and this answers 404. The
   * answer must cover every question in the ask -- the gateway refuses a partial
   * one rather than hand the model half an answer.
   */
  answerQuestion(sessionId: string, questionId: string, answers: QuestionAnswer[]): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/answer`, { answers })
  }

  /** Declines to answer: the tool call fails, and the model carries on knowing that. */
  declineQuestion(sessionId: string, questionId: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/cancel`)
  }

  /**
   * Decides one permission prompt.
   *
   * `allowed-once` is the vocabulary's only grant and it covers exactly the call
   * being decided -- there is deliberately no way from here to widen a session's
   * policy or to remember the decision.
   */
  decideApproval(sessionId: string, decisionId: string, outcome: 'allowed-once' | 'rejected'): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(decisionId)}/decide`, { outcome })
  }

  /**
   * Hands the session's slot back to the gateway.
   *
   * Not a delete of the conversation. The gateway keeps the durable transcript,
   * so `history` still answers and `adopt` can bring the session back; what is
   * given up is one slot against the gateway's `maxSessions`. That slot is the
   * resource that actually runs out: once the cap is reached the gateway can
   * neither create a session nor adopt an existing one, so a manager that never
   * released would eventually be unable to continue even an old conversation.
   *
   * Idempotent -- an unknown or already-released id answers 200 with
   * `released: false` rather than 404 -- so a cleanup path can call it
   * unconditionally.
   */
  release(sessionId: string): Promise<ReleasedSession> {
    return this.request<ReleasedSession>('DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
  }
}

export const buildClients = (endpoints: Record<string, ResolvedEndpoint>): Map<string, GatewayClient> => {
  const map = new Map<string, GatewayClient>()
  for (const endpoint of Object.values(endpoints)) map.set(endpoint.id, new GatewayClient(endpoint))
  return map
}

/**
 * 债务 E10:apiproxy 等不经过 gateway 的路径仍需一个占位 client(RunInput 等
 * 类型要求非空)——它指向永不连通的地址,分支逻辑保证它绝不会被真调。
 */
export const dummyGatewayClient = (): GatewayClient =>
  new GatewayClient({
    id: 'dummy',
    url: 'http://127.0.0.1:1',
    driver: 'gateway',
    prefix: '/api-gw/v1',
    key: '',
    sandboxBase: null,
    sandboxKey: '',
    spawn: null, access: null,
  })
