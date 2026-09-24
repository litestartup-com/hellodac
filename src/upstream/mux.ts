/**
 * WebSocket mux consumer for the DSH apiproxy event stream.
 *
 * The mux endpoint (`ws://<host>/api/events.mux`) is a full-volume broadcast:
 * every active session's events are multiplexed onto one WebSocket. This module
 * maintains one connection per endpoint and distributes frames to per-session
 * listeners.
 *
 * 债务 E16:wire 现实核实笔记已迁设计库事实卡 dsh-facts.md §9(mux 段)。
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
  /** 帧体:信封层不判形状(stream/error 等无判别 schema),dispatch 内经 parseMuxPayload 判别。 */
  payload: Record<string, unknown>
}

/** 债务 E8:envelope 判别 schema(payload 细形状在 translate.ts 的帧判别里)。 */
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
  /** 债务 A4:曾连上过(重连成功后要向订阅者广播 stream_reconnected)。 */
  wasConnected: boolean
  /** 债务 A4:连续断线计数,驱动指数退避;连上即清零。 */
  reconnectAttempt: number
}

const connections = new Map<string, MuxConnection>()

/** 债务 B6:重连累计计数(metrics 展示;每次断线重连 +1)。 */
let reconnectCount = 0
export const getMuxReconnects = (): number => reconnectCount

/**
 * 债务卡片链(2026-09-17):帧丢弃与重连的诊断日志。生产由 index.ts 注入
 * app.log.warn;未注入时静默(测试不刷屏)。
 */
let muxLog: (line: string) => void = () => {}
export const setMuxLogger = (log: (line: string) => void): void => {
  muxLog = log
}

const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 30_000

/**
 * 债务 A4:指数退避 + ±25% 抖动(纯函数,可测)。
 * 固定 3s 无退避会在上游抖动时形成重连风暴。
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
  // 债务 E8:帧体判别——已知帧型形状不符或未知帧型一律丢弃(fail-loud,不猜)。
  const frame = parseMuxPayload(env.payload)
  if (frame === null) {
    // 债务卡片链:丢弃必须留痕——question/approval 帧被 schema 拒掉时,卡片
    // 不显示且 ask_user_question 挂起,没有这行日志就无法区分「没收到」与
    // 「收到但被判别丢弃」。
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
      // goal 投影 → Ongoing Goal 条（2026-09-11）；其余 key 仍丢弃。
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

  // 债务 R5:只有真实 onopen 过的 socket 才算「曾连接」。首连失败(握手被拒/
  // 网络不通)同样触发 onclose,若在 onclose 里无条件置 wasConnected,下一次
  // 首次成功连接就会被当成「重连」广播 stream_reconnected,runner 据此把
  // 好好的 run 错标为「结果未知」失败。判据必须是每个 socket 自己的 onopen。
  let opened = false

  ws.onopen = () => {
    opened = true
    // 债务 A4:重连成功即向所有活跃订阅者广播 stream_reconnected——
    // 断线期间丢掉的 turn_end 不会无声无息,上层按通知显性失败/对账。
    // 首连(wasConnected=false)不发。
    conn.reconnectAttempt = 0
    if (!conn.wasConnected) return
    // 债务卡片链:断线窗口内广播的 question/approval 帧已经丢了(上游只发一次),
    // 重连必须留痕——排障时这行与 facade 的「unanswered, delegating」配对定位。
    muxLog(`mux ${conn.ep.base}: reconnected (${conn.listeners.size} session(s) subscribed)`)
    for (const sessionId of conn.listeners.keys()) {
      emit(conn, sessionId, { kind: 'stream_reconnected', seq: 0 })
    }
  }

  ws.onmessage = (event: MessageEvent) => {
    const data = typeof event.data === 'string' ? event.data : String(event.data)
    const env = parseMuxFrame(data)
    if (env === null) {
      // 非 server-request 信封(或坏 JSON)——老契约里 mux 只下行 server-request,
      // 出现别的形状值得留一行(节流:截断前 200 字符)。
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
    // 债务 R5:「曾连接」只由真实 onopen 确立(见 attach 顶部注释)。
    if (opened) conn.wasConnected = true
    // Auto-reconnect if there are still listeners.
    if (conn.listeners.size > 0) {
      reconnectCount += 1
      // 债务卡片链:断线留痕(带订阅会话数)——卡片帧只广播一次,断线窗口即丢失窗口。
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

/** 连接工厂(测试注入假 socket 用);生产走真实 WebSocket。 */
type SocketFactory = (conn: MuxConnection) => WebSocket
let socketFactory: SocketFactory = openSocket

/** Testing only:替换连接工厂,验证重连通知/退订修复等连接级行为。 */
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
    // 债务 A4:只有当 map 里挂着的还是本订阅创建的 set 时才删除——旧 unsub
    // 在「退订后又重新订阅」之后调用,会把新订阅的 set 从 map 误删。
    if (set.size === 0 && conn.listeners.get(sessionId) === set) conn.listeners.delete(sessionId)
    maybeClose(conn, ep.base)
  }
}

/**
 * 债务 E13:subscribeAll(全局订阅)已删除——全仓无生产调用者,是进入公共
 * barrel 的死接口,读者会误以为「全局订阅」是被使用的特性。需要时再加回
 * 并补测试。
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
