import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for dsh-api-gateway, used by the runner tests.
 *
 * It reproduces the real wire behaviour verified against the gateway source,
 * including the parts that are easy to get wrong:
 *
 * - `retry: 2000` is written before the first frame, so the first SSE block
 *   contains a non-data line too.
 * - the `hello` frame carries a `log` of prior events, which a correct consumer
 *   must not count as live usage.
 * - the stream stays open after `turn_end`; only the client closes it.
 * - `POST /messages` requires `content`, and answers 400 for `text`.
 * - `adopt` is idempotent for a live session and is the only way back for a
 *   cold one; `history` works for both and does not wake anything.
 * - `DELETE /sessions/:id` frees the slot and turns the session cold, so a later
 *   turn on it has to adopt; the transcript stays readable. It answers 200 with
 *   `released: false` for an id it is not holding, rather than 404.
 */

export interface FakeFrame {
  kind: string
  seq?: number
  [key: string]: unknown
}

export interface FakeScript {
  /** Frames emitted after the instruction is delivered. */
  frames: FakeFrame[]
  /**
   * Per-turn frame overrides. Turn 1 uses `framesByTurn[0]`, and so on; any turn
   * without an entry falls back to `frames`. Lets a test give two turns
   * different usage, which is how double-billing is detected.
   */
  framesByTurn?: FakeFrame[][]
  /** Milliseconds between frames. */
  gapMs?: number
  /** Replayed inside the hello frame, as the real gateway does. */
  history?: FakeFrame[]
  /** Returned by GET /sessions/:id/history. Defaults to `history`. */
  historyEvents?: FakeFrame[]
  /** The gateway's own name for the session, as history reports it. */
  sessionTitle?: string | null
  provider?: string | null
  model?: string | null
  /** Fail session creation with this status. */
  failCreateStatus?: number
  /** Never emit anything, to exercise the timeout. */
  silent?: boolean
  /**
   * Sessions the gateway is NOT holding in memory. `messages` and `stream`
   * answer 404 for these until they are adopted, exactly as the real gateway
   * does after a DSH restart.
   */
  coldSessions?: string[]
  /** Refuse adopt: 403 `adopt_disabled`, or 400 `adopt_failed` with this detail. */
  adoptFail?: { status: number; error: string; detail?: string }
  /** Fail DELETE /sessions/:id with this status, to exercise cleanup failures. */
  failReleaseStatus?: number
  /** Fail GET /history with this status, e.g. 404 for a session DSH has lost. */
  failHistoryStatus?: number
  /**
   * Report this cwd instead of the requested one, reproducing the gateway's
   * `workspaceMode: 'auto'` remap (index.ts:509).
   */
  overrideCwd?: string
}

export interface FakeGateway {
  url: string
  prefix: string
  close: () => Promise<void>
  /** Requests received, for asserting the runner's call sequence. */
  calls: { method: string; path: string; body?: unknown }[]
  /** Bodies delivered to /messages. */
  messages: unknown[]
  questionAnswers: unknown[]
  cancels: number
  /** Sessions adopted, in order, so a test can assert revival happened once. */
  adopts: string[]
  /** Sessions released, in order, so a test can assert slots are handed back. */
  releases: string[]
  script: FakeScript
  setScript: (script: Partial<FakeScript>) => void
}

const PREFIX = '/api-gw/v1'

/**
 * Frame kinds the gateway sends without a `seq`.
 *
 * These are the ones it originates rather than maps from the session log, so
 * they have no position in the durable transcript to report.
 */
const LIVE_ONLY = new Set(['question_asked', 'question_resolved', 'approval_pending', 'approval_resolved'])

export const startFakeGateway = async (initial: FakeScript, apiKey = 'test-key'): Promise<FakeGateway> => {
  const state: FakeScript = { gapMs: 1, ...initial }
  const calls: FakeGateway['calls'] = []
  const messages: unknown[] = []
  const questionAnswers: unknown[] = []
  const adopts: string[] = []
  const releases: string[] = []
  let cancels = 0
  let sessionCounter = 0

  // Per-session message accounting, so turn two waits for its own instruction.
  // A single global "has any message arrived" flag would let the second stream
  // fire immediately off the first turn's message and the test would pass while
  // the conversation was actually broken.
  const sentPerSession = new Map<string, number>()
  const consumedPerSession = new Map<string, number>()
  const waiters = new Map<string, (() => void)[]>()
  /** Turns already streamed, for `framesByTurn`. */
  let turnsStarted = 0

  const isCold = (sessionId: string): boolean => (state.coldSessions ?? []).includes(sessionId)
  const warm = (sessionId: string): void => {
    state.coldSessions = (state.coldSessions ?? []).filter((s) => s !== sessionId)
  }

  /** Resolves when an instruction arrives for this session that no turn has used. */
  const awaitInstruction = (sessionId: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const take = (): void => {
        consumedPerSession.set(sessionId, (consumedPerSession.get(sessionId) ?? 0) + 1)
        resolve()
      }
      if ((sentPerSession.get(sessionId) ?? 0) > (consumedPerSession.get(sessionId) ?? 0)) {
        take()
        return
      }
      const list = waiters.get(sessionId) ?? []
      list.push(take)
      waiters.set(sessionId, list)
    })

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (chunks.length === 0) return undefined
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      return undefined
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (req.headers['x-api-key'] !== apiKey) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      const rest = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path

      if (rest === '/health' && method === 'GET') {
        calls.push({ method, path: rest })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', enabled: true, sessions: 0, apiKeySet: true }))
        return
      }

      if (rest === '/sessions' && method === 'POST') {
        const body = await readBody(req)
        calls.push({ method, path: rest, body })
        if (state.failCreateStatus !== undefined) {
          res.writeHead(state.failCreateStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'session_create_failed' }))
          return
        }
        sessionCounter += 1
        const sessionId = `sess-${sessionCounter}`
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            sessionId,
            status: 'idle',
            provider: state.provider ?? 'deepseek-official',
            model: state.model ?? 'deepseek-v4-pro',
            cwd: state.overrideCwd ?? (body as { cwd?: string } | undefined)?.cwd ?? null,
            workspace: null,
          }),
        )
        return
      }

      const historyMatch = /^\/sessions\/([^/]+)\/history$/.exec(rest)
      if (historyMatch !== null && method === 'GET') {
        const sessionId = historyMatch[1] ?? ''
        calls.push({ method, path: rest })
        if (state.failHistoryStatus !== undefined) {
          res.writeHead(state.failHistoryStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'session_not_found' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        // Readable whether or not the session is live, and `adopted` is how the
        // caller learns which of the two it is.
        res.end(
          JSON.stringify({
            sessionId,
            adopted: !isCold(sessionId),
            header: { id: sessionId, title: state.sessionTitle ?? null, cwd: state.overrideCwd ?? null },
            events: state.historyEvents ?? state.history ?? [],
          }),
        )
        return
      }

      const adoptMatch = /^\/sessions\/([^/]+)\/adopt$/.exec(rest)
      if (adoptMatch !== null && method === 'POST') {
        const sessionId = adoptMatch[1] ?? ''
        calls.push({ method, path: rest })
        if (state.adoptFail !== undefined) {
          res.writeHead(state.adoptFail.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: state.adoptFail.error, detail: state.adoptFail.detail }))
          return
        }
        adopts.push(sessionId)
        // Idempotent: a live session is returned untouched, a cold one is warmed.
        warm(sessionId)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            sessionId,
            mode: 'resumed',
            status: 'idle',
            provider: state.provider ?? 'deepseek-official',
            model: state.model ?? 'deepseek-v4-pro',
            cwd: state.overrideCwd ?? null,
            history: state.historyEvents ?? state.history ?? [],
          }),
        )
        return
      }

      const streamMatch = /^\/sessions\/([^/]+)\/stream$/.exec(rest)
      if (streamMatch !== null && method === 'GET') {
        const sessionId = streamMatch[1] ?? ''
        calls.push({ method, path: rest })
        if (isCold(sessionId)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'session_not_found', hint: 'adopt the session first' }))
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        // Exactly as the gateway does it: retry line, then hello in the same block.
        res.write('retry: 2000\n')
        res.write(
          `data: ${JSON.stringify({
            kind: 'hello',
            seq: 0,
            sessionId,
            status: 'idle',
            mode: 'live',
            workspace: null,
            log: state.history ?? [],
          })}\n\n`,
        )

        let closed = false
        req.on('close', () => {
          closed = true
        })

        // Wait for the instruction before emitting the turn, mirroring reality.
        await awaitInstruction(sessionId)

        if (state.silent === true) return

        const turnIndex = turnsStarted
        turnsStarted += 1
        const frames = state.framesByTurn?.[turnIndex] ?? state.frames

        let seq = 1
        for (const frame of frames) {
          if (closed) return
          await new Promise((r) => setTimeout(r, state.gapMs ?? 1))
          if (closed) return
          // `sleep` is a script instruction, not a frame: it is how a test writes
          // a long gap in the middle of a turn, which is otherwise impossible to
          // express through one uniform `gapMs`.
          if (frame.kind === 'sleep') {
            await new Promise((r) => setTimeout(r, typeof frame.ms === 'number' ? frame.ms : 0))
            continue
          }
          // Frames the real gateway originates itself carry NO seq: they are live
          // negotiation, not entries in the durable log (see the gateway's
          // `gatewayFrame`). Stamping one here would let a test pass against a
          // stream shape that does not exist.
          res.write(`data: ${JSON.stringify(LIVE_ONLY.has(frame.kind) ? frame : { seq: seq++, ...frame })}\n\n`)
        }
        // Deliberately does NOT end the response: the real gateway keeps the
        // subscription open until the client disconnects.
        return
      }

      const messageMatch = /^\/sessions\/([^/]+)\/messages$/.exec(rest)
      if (messageMatch !== null && method === 'POST') {
        const sessionId = messageMatch[1] ?? ''
        const body = await readBody(req)
        calls.push({ method, path: rest, body })
        if (isCold(sessionId)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'session_not_found', hint: 'adopt the session first' }))
          return
        }
        const content = (body as { content?: unknown } | undefined)?.content
        const ok = (typeof content === 'string' && content !== '') || (Array.isArray(content) && content.length > 0)
        if (!ok) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'content must be a non-empty string or a non-empty array of content blocks' }))
          return
        }
        messages.push(content)
        sentPerSession.set(sessionId, (sentPerSession.get(sessionId) ?? 0) + 1)
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessionId, messageId: `msg-${messages.length}`, status: 'busy' }))
        waiters.get(sessionId)?.shift()?.()
        return
      }

      const answerMatch = /^\/sessions\/([^/]+)\/questions\/([^/]+)\/answer$/.exec(rest)
      if (answerMatch !== null && method === 'POST') {
        const body = await readBody(req)
        calls.push({ method, path: rest, body })
        questionAnswers.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      const releaseMatch = /^\/sessions\/([^/]+)$/.exec(rest)
      if (releaseMatch !== null && method === 'DELETE') {
        const sessionId = releaseMatch[1] ?? ''
        calls.push({ method, path: rest })
        if (state.failReleaseStatus !== undefined) {
          res.writeHead(state.failReleaseStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'release_failed' }))
          return
        }
        // Idempotent: an id the gateway is not holding is not an error.
        const held = !isCold(sessionId)
        if (held) {
          releases.push(sessionId)
          // The slot is gone, so the session is cold from here on -- the next turn
          // on it must adopt. This is what makes releasing recoverable rather
          // than destructive, and a test can only see the difference here.
          state.coldSessions = [...(state.coldSessions ?? []), sessionId]
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            sessionId,
            released: held,
            disposed: held,
            ...(held ? { mode: 'created' } : {}),
            historyRetained: true,
          }),
        )
        return
      }

      const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(rest)
      if (cancelMatch !== null && method === 'POST') {
        calls.push({ method, path: rest })
        cancels += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found', path: rest }))
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    prefix: PREFIX,
    calls,
    messages,
    questionAnswers,
    adopts,
    releases,
    get cancels() {
      return cancels
    },
    script: state,
    setScript: (patch) => Object.assign(state, patch),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
