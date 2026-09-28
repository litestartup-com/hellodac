/**
 * WebSocket mux consumer for the DSH apiproxy event stream.
 *
 * The mux endpoint (`ws://<host>/api/events.mux`) is a full-volume broadcast:
 * every active session's events are multiplexed onto one WebSocket. This module
 * maintains one connection per endpoint and distributes frames to per-session
 * listeners.
 *
 * Debt E16: the notes verifying the wire reality moved to the design library's fact card dsh-facts.md §9 (the mux section).
 */

import type { UpstreamEndpoint } from './rpc.js'
import { parseMuxPayload } from './translate.js'
import type { GatewayFrame } from '../gateway/stream.js'
import { z } from 'zod'
import {
  muxFrameToGatewayFrame,
  questionRequestedFrame, questionResolvedFrame,
  approvalRequestedFrame, approvalResolvedFrame,
  goalProjectionFrame,
} from './translate.js'

export type MuxListener = (sessionId: string, frame: GatewayFrame) => void

/** One parsed WebSocket message: the ServerRequest full form. */
export interface WireEnvelope {
  type: 'server-request'
  rpcId: string
  method: string
  /** The frame body: the envelope layer does not judge its shape (stream/error and friends have no discriminated schema); dispatch judges it through parseMuxPayload. */
  payload: Record<string, unknown>
}

/** Debt E8: the envelope's discriminated schema (the payload's fine shape lives in translate.ts's frame discrimination). */
const wireEnvelopeSchema = z.object({
  type: z.literal('server-request'),
  rpcId: z.string().optional().default(''),
  method: z.string(),
  payload: z.record(z.string(), z.unknown()),
})

interface MuxConnection {
  ep: UpstreamEndpoint
  ws: WebSocket | null
  listeners: Map<string, Set<MuxListener>>
  closed: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** approvalId → the rpcId of the original approval/requested frame. */
  approvalRpcIds: Map<string, string>
  /** Debt A4: it has connected at least once (after a successful reconnect, stream_reconnected is broadcast to subscribers). */
  wasConnected: boolean
  /** Debt A4: the consecutive-disconnect count that drives exponential backoff; reset to zero on connect. */
  reconnectAttempt: number
}

const connections = new Map<string, MuxConnection>()

/** Debt B6: the cumulative reconnect count (shown in metrics; +1 for every disconnect-reconnect). */
let reconnectCount = 0
export const getMuxReconnects = (): number => reconnectCount

/**
 * Debt card chain (2026-09-17): the diagnostic log for dropped frames and reconnects. Production injects
 * app.log.warn from index.ts; without an injection it stays silent (tests do not flood the output).
 */
let muxLog: (line: string) => void = () => {}
export const setMuxLogger = (log: (line: string) => void): void => {
  muxLog = log
}

const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 30_000

/**
 * Debt A4: exponential backoff plus ±25% jitter (a pure function, testable).
 * A fixed 3s with no backoff turns upstream flapping into a reconnect storm.
 */
export const nextReconnectDelay = (attempt: number): number => {
  const exp = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(attempt - 1, 0), RECONNECT_MAX_MS)
  const jitter = exp * 0.25 * (Math.random() * 2 - 1)
  return Math.round(exp + jitter)
}

/**
 * Derives the WebSocket URL from an HTTP endpoint base.
 * `http://host:port/api` → `ws://host:port/api/events.mux`
 * `https://…` → `wss://…`
 */
export const muxUrl = (base: string): string => {
  const wsBase = base.replace(/^http/, 'ws')
  return `${wsBase}/events.mux`
}

/**
 * Parses one WebSocket message into a server-request envelope.
 * Returns `null` for anything that is not a well-formed server-request.
 * Exported for testing.
 */
export const parseMuxFrame = (data: string): WireEnvelope | null => {
  try {
    const parsed: unknown = JSON.parse(data)
    const env = wireEnvelopeSchema.safeParse(parsed)
    if (!env.success) return null
    return {
      type: 'server-request',
      rpcId: env.data.rpcId,
      method: env.data.method,
      payload: env.data.payload,
    }
  } catch {
    return null
  }
}

const emit = (conn: MuxConnection, sessionId: string, gw: GatewayFrame): void => {
  const listeners = conn.listeners.get(sessionId)
  if (listeners !== undefined) {
    for (const listener of listeners) listener(sessionId, gw)
  }
}

const dispatch = (conn: MuxConnection, env: WireEnvelope): void => {
  // Debt E8: frame-body discrimination -- a known frame type with the wrong shape or an unknown frame type is dropped (fail loud, no guessing).
  const frame = parseMuxPayload(env.payload)
  if (frame === null) {
    // Debt card chain: a drop must leave a trace -- when a question/approval frame is rejected by the schema the
    // card never shows and ask_user_question hangs, and without this log line there is no way to tell "never
    // arrived" from "arrived but was dropped by the discrimination".
    muxLog(`mux ${conn.ep.base}: dropped frame (shape mismatch or unknown type) method=${env.method} payload=${JSON.stringify(env.payload).slice(0, 300)}`)
    return
  }
  const sessionId = frame.sessionId

  switch (frame.type) {
    case 'session/event': {
      const gw = muxFrameToGatewayFrame(frame)
      if (gw === null) return
      emit(conn, sessionId, gw)
      return
    }
    case 'question/requested': {
      emit(conn, sessionId, questionRequestedFrame(env.rpcId, frame))
      return
    }
    case 'question/resolved': {
      emit(conn, sessionId, questionResolvedFrame(frame))
      return
    }
    case 'approval/requested': {
      conn.approvalRpcIds.set(frame.approvalId, env.rpcId)
      emit(conn, sessionId, approvalRequestedFrame(env.rpcId, frame))
      return
    }
    case 'approval/resolved': {
      const decisionId = conn.approvalRpcIds.get(frame.approvalId) ?? null
      if (decisionId !== null) conn.approvalRpcIds.delete(frame.approvalId)
      emit(conn, sessionId, approvalResolvedFrame(frame, decisionId))
      return
    }
    case 'session/projection': {
      // goal projection -> the Ongoing Goal bar (2026-09-11); the other keys are still dropped.
      const gw = goalProjectionFrame(frame)
      if (gw !== null) emit(conn, sessionId, gw)
      return
    }
    default:
      return
  }
}

/**
 * Opens the WebSocket. When a key is configured, custom headers are passed in
 * the options bag (supported by Node's undici WebSocket); older runtimes that
 * reject the options form fall back to a plain connection.
 */

/** Wires one socket's handlers; the socket connects immediately on construction. */
const attach = (conn: MuxConnection): void => {
  const ws = socketFactory(conn)
  conn.ws = ws

  // Debt R5: only a socket that really fired onopen counts as "has connected". A failed first connect (handshake
  // refused / network down) fires onclose too, and if onclose set wasConnected unconditionally, the next first
  // successful connection would be taken for a "reconnect" and broadcast stream_reconnected, on which the runner
  // would mislabel a perfectly good run as an "outcome unknown" failure. The criterion has to be each socket's own onopen.
  let opened = false

  ws.onopen = () => {
    opened = true
    // Debt A4: a successful reconnect broadcasts stream_reconnected to every active subscriber --
    // a turn_end lost during the outage does not go unremarked, and the layer above fails loudly / reconciles on
    // that notice. The first connect (wasConnected=false) sends nothing.
    conn.reconnectAttempt = 0
    if (!conn.wasConnected) return
    // Debt card chain: the question/approval frames broadcast inside the outage window are already gone (the upstream
    // sends them once), so a reconnect must leave a trace -- in debugging this line pairs with the facade's "unanswered, delegating" to locate it.
    muxLog(`mux ${conn.ep.base}: reconnected (${conn.listeners.size} session(s) subscribed)`)
    for (const sessionId of conn.listeners.keys()) {
      emit(conn, sessionId, { kind: 'stream_reconnected', seq: 0 })
    }
  }

  ws.onmessage = (event: MessageEvent) => {
    const data = typeof event.data === 'string' ? event.data : String(event.data)
    const env = parseMuxFrame(data)
    if (env === null) {
      // Not a server-request envelope (or broken JSON) -- under the old contract the mux only sends server-request
      // downstream, so another shape is worth a line (throttled: the first 200 characters).
      muxLog(`mux ${conn.ep.base}: dropped envelope: ${data.slice(0, 200)}`)
      return
    }
    if (env.method === 'stream/error') {
      // Host-side failure: the host closes right after this frame. Treat it as
      // a closed connection so the reconnect path runs.
      try { ws.close() } catch { /* already closing */ }
      return
    }
    dispatch(conn, env)
  }

  ws.onerror = () => {
    // onerror always fires before onclose, and onclose handles reconnection.
  }

  ws.onclose = () => {
    if (conn.closed) return
    // Debt R5: "has connected" is established only by a real onopen (see the comment at the top of attach).
    if (opened) conn.wasConnected = true
    // Auto-reconnect if there are still listeners.
    if (conn.listeners.size > 0) {
      reconnectCount += 1
      // Debt card chain: leave a trace of the disconnect (with the subscribed chat count) -- a card frame is broadcast once, so the outage window is the loss window.
      muxLog(`mux ${conn.ep.base}: connection lost (${conn.listeners.size} session(s) subscribed), reconnecting in ${nextReconnectDelay(Math.max(conn.reconnectAttempt - 1, 0))}ms`)
      if (conn.reconnectTimer === null) {
        const delay = nextReconnectDelay(conn.reconnectAttempt)
        conn.reconnectAttempt += 1
        conn.reconnectTimer = setTimeout(() => {
          conn.reconnectTimer = null
          if (conn.closed) return
          attach(conn)
        }, delay)
      }
    } else {
      connections.delete(conn.ep.base)
    }
  }
}

const openSocket = (conn: MuxConnection): WebSocket => {
  const url = muxUrl(conn.ep.base)
  let ws: WebSocket
  if (conn.ep.key !== '') {
    try {
      ws = new WebSocket(url, { headers: { 'x-api-key': conn.ep.key } })
    } catch {
      ws = new WebSocket(url)
    }
  } else {
    ws = new WebSocket(url)
  }
  return ws
}

/** The connection factory (tests inject a fake socket); production goes through a real WebSocket. */
type SocketFactory = (conn: MuxConnection) => WebSocket
let socketFactory: SocketFactory = openSocket

/** Testing only: replace the connection factory to verify connection-level behaviour such as reconnect notices and the unsubscribe fix. */
export const _setSocketFactory = (factory: SocketFactory): void => {
  socketFactory = factory
}

const connect = (ep: UpstreamEndpoint): MuxConnection => {
  const key = ep.base
  const existing = connections.get(key)
  if (existing !== undefined && !existing.closed) return existing

  const conn: MuxConnection = {
    ep,
    ws: null,
    listeners: new Map(),
    closed: false,
    reconnectTimer: null,
    approvalRpcIds: new Map(),
    wasConnected: false,
    reconnectAttempt: 0,
  }
  connections.set(key, conn)
  attach(conn)
  return conn
}

/**
 * Subscribe to events for a specific session on a given endpoint.
 * Returns a function that removes the subscription.
 *
 * The first subscription for an endpoint opens the mux WebSocket.
 * The last unsubscription closes it.
 */
export const subscribe = (ep: UpstreamEndpoint, sessionId: string, listener: MuxListener): (() => void) => {
  const conn = connect(ep)
  const set = conn.listeners.get(sessionId) ?? new Set()
  set.add(listener)
  conn.listeners.set(sessionId, set)

  return () => {
    set.delete(listener)
    // Debt A4: delete only when the set hanging in the map is still the one this subscription created -- an old unsub
    // called after "unsubscribe, then subscribe again" would wrongly delete the new subscription's set from the map.
    if (set.size === 0 && conn.listeners.get(sessionId) === set) conn.listeners.delete(sessionId)
    maybeClose(conn, ep.base)
  }
}

/**
 * Debt E13: subscribeAll (global subscription) was deleted -- there is no production caller anywhere in the repo, it
 * was a dead interface that had reached the public barrel, and readers would wrongly assume "global subscription" is
 * a used feature. Add it back with tests when it is needed.
 */

const maybeClose = (conn: MuxConnection, key: string): void => {
  if (conn.listeners.size === 0) {
    conn.closed = true
    if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer)
    try { conn.ws?.close() } catch { /* already closed */ }
    connections.delete(key)
  }
}

/**
 * Close all mux connections. For tests and shutdown.
 */
export const closeAllMux = (): void => {
  for (const conn of connections.values()) {
    conn.closed = true
    if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer)
    try { conn.ws?.close() } catch { /* already closed */ }
  }
  connections.clear()
}

/**
 * Returns a promise that resolves when a specific frame kind arrives for a session,
 * or rejects on timeout. Useful for waiting on `turn_end`.
 */
export const waitForFrame = (
  ep: UpstreamEndpoint,
  sessionId: string,
  kind: string,
  timeoutMs: number,
): Promise<GatewayFrame> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`timeout waiting for ${kind} on session ${sessionId}`))
    }, timeoutMs)

    const unsub = subscribe(ep, sessionId, (_sid, frame) => {
      if (frame.kind === kind) {
        clearTimeout(timer)
        unsub()
        resolve(frame)
      }
    })
  })
