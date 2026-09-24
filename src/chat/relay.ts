/**
 * 债务 E2:relay(SSE pub-sub)从 routes/chat.ts 抽为独立模块——三层拆分
 * (relay / 回合编排 / CRUD 路由壳)的第一层。
 *
 * 一个 chat 一个 relay:浏览器不直连 gateway 流(gateway 需要端点 API key,
 * 密钥绝不进浏览器),N 个开着的标签页只花一个上游订阅,不是 N 个。
 */
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify'
import type { Db } from '../db/index.js'
import { getChat } from './store.js'

/**
 * Browsers watching one chat.
 *
 * A relay rather than letting each browser open the gateway stream directly:
 * the gateway needs the endpoint API key, and that key must never reach a
 * browser. It also means N open tabs cost one upstream subscription, not N.
 */
interface Relay {
  subscribers: Set<FastifyReply>
}

const relays = new Map<string, Relay>()

const relayFor = (chatId: string): Relay => {
  const existing = relays.get(chatId)
  if (existing !== undefined) return existing
  const created: Relay = { subscribers: new Set() }
  relays.set(chatId, created)
  return created
}

/** 蜂群 P2：给任意会话推一帧（internal 派工完成时用它推 delegation 帧）。 */
export const publish = (chatId: string, payload: unknown): void => {
  const relay = relays.get(chatId)
  if (relay === undefined) return
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const reply of relay.subscribers) {
    // Checked rather than caught: writing to a destroyed socket does not throw,
    // so a catch here would never run and a dead watcher would be written to
    // forever.
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      relay.subscribers.delete(reply)
      continue
    }
    reply.raw.write(frame)
  }
  if (relay.subscribers.size === 0) relays.delete(chatId)
}

/**
 * How many chats have an open relay. For tests.
 *
 * A leaked subscriber is invisible from the outside -- it costs one browser
 * connection out of the six an origin gets, which shows up much later as "the
 * whole site hangs" -- so it needs to be assertable.
 */
export const openChatRelays = (): number => relays.size

/** Releases every open relay so the process can exit cleanly. */
export const closeChatRelays = (): void => {
  for (const relay of relays.values()) {
    for (const reply of relay.subscribers) {
      try {
        reply.raw.end()
      } catch {
        // Already gone.
      }
    }
  }
  relays.clear()
}

/** SSE 事件流路由：live 帧只经 relay,历史由 GET /api/chats/:id 提供。 */
export const registerRelayRoute = (
  app: FastifyInstance,
  db: Db,
  requireUser: preHandlerHookHandler,
  replayCards: (chatId: string) => Array<Record<string, unknown>> = () => [],
): void => {
  /**
   * Live frames for one chat, as server-sent events.
   *
   * Carries live frames only. History comes from `GET /api/chats/:id`, because
   * the gateway's own `hello` frame replays the entire durable log -- relaying
   * that would re-render the whole conversation on every reconnect, and the same
   * confusion between replayed and live events is what makes double-billing
   * possible upstream.
   */
  app.get<{ Params: { id: string } }>('/api/chats/:id/events', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null || chat.removedAt !== null) return reply.code(404).send({ error: 'unknown_chat' })

    const relay = relayFor(chat.id)

    // Fastify is told to stop tracking this reply: the response is written by
    // hand and never ends, so leaving it inside the normal lifecycle only means
    // the framework is holding a request that will never complete.
    reply.hijack()

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx and Caddy would otherwise buffer the stream into uselessness.
      'x-accel-buffering': 'no',
    })
    reply.raw.write('retry: 3000\n')
    reply.raw.write(`data: ${JSON.stringify({ kind: 'hello', chatId: chat.id, at: Date.now() })}\n\n`)
    // 债务卡片链(2026-09-17):hello 之后重放挂起卡片帧——断流窗口/页面恢复时
    // question/approval 卡片必须回来(卡片帧不进 transcript,重放不会画重块)。
    for (const frame of replayCards(chat.id)) {
      reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`)
    }
    relay.subscribers.add(reply)

    // Phones drop idle sockets, and so do proxies. A comment line is a no-op for
    // the client but keeps the connection open.
    //
    // The exit condition is `destroyed`, not a thrown error: `write` on a dead
    // socket does not throw, it reports through a callback. A try/catch here
    // never fires, so the interval and the subscriber would live until the
    // process exits -- one leaked entry per abandoned browser.
    const heartbeat = setInterval(() => {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        clearInterval(heartbeat)
        drop()
        return
      }
      reply.raw.write(': ping\n\n')
    }, 25_000)

    const drop = (): void => {
      clearInterval(heartbeat)
      relay.subscribers.delete(reply)
      // Dropped when the last watcher leaves, so the map cannot grow without
      // bound over a long uptime. Safe during a turn in flight: `publish` looks
      // the relay up by chat id on every frame, so a browser that connects
      // mid-turn gets a fresh relay and still receives the rest of the stream.
      if (relay.subscribers.size === 0) relays.delete(chat.id)
    }

    // Both, deliberately: `close` covers the browser going away cleanly, `error`
    // covers a socket that broke. Either way this subscriber must stop being
    // counted, or a chat can end up with watchers nobody is watching from.
    request.raw.on('close', drop)
    request.raw.on('error', drop)
    reply.raw.on('error', drop)
  })
}
