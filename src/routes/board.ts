import { watch, type FSWatcher } from 'node:fs'
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { BOARD_DIR, boardSource, readBoard } from '../board/store.js'

/**
 * The dashboard API.
 *
 * manager owns the rendering; the workspace only supplies data. Every agent --
 * personal, company, product -- goes through this same path, differing only in
 * the template its workspace was initialised from.
 */

interface Watcher {
  watcher: FSWatcher
  subscribers: Set<FastifyReply>
  timer: NodeJS.Timeout | null
}

/**
 * One filesystem watcher per agent, shared by every open board.
 *
 * A watcher per connection would burn a file handle for every phone left on the
 * page and would report the same change several times over.
 */
const watchers = new Map<string, Watcher>()

const broadcast = (entry: Watcher, payload: unknown): void => {
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const reply of entry.subscribers) {
    try {
      reply.raw.write(frame)
    } catch {
      entry.subscribers.delete(reply)
    }
  }
}

const ensureWatcher = (agent: ResolvedAgent, log: FastifyInstance['log']): Watcher | null => {
  const existing = watchers.get(agent.id)
  if (existing !== undefined) return existing

  const { dir, present } = boardSource(agent.workspacePath)
  if (!present) return null

  let entry: Watcher
  try {
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename !== null && !filename.toString().endsWith('.json')) return
      // One logical save arrives as several events, because an atomic write is
      // a temp file plus a rename. Coalesce so the board reloads once.
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        broadcast(entry, { kind: 'changed', at: Date.now() })
      }, 300)
    })
    watcher.on('error', (error) => log.warn(`board watcher for ${agent.id} failed: ${error.message}`))
    entry = { watcher, subscribers: new Set(), timer: null }
  } catch (error) {
    log.warn(`could not watch ${dir}: ${(error as Error).message}`)
    return null
  }

  watchers.set(agent.id, entry)
  return entry
}

/** Releases every watcher and open stream so the process can exit cleanly. */
export const closeBoardWatchers = (): void => {
  for (const entry of watchers.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.watcher.close()
    for (const reply of entry.subscribers) {
      try {
        reply.raw.end()
      } catch {
        // Already gone.
      }
    }
  }
  watchers.clear()
}

export const registerBoardRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  requireUser: preHandlerHookHandler,
): void => {
  const agentOr404 = (id: string, reply: FastifyReply): ResolvedAgent | null => {
    const agent = config.agents[id]
    if (agent === undefined) {
      void reply.code(404).send({ error: 'unknown_agent' })
      return null
    }
    return agent
  }

  app.get<{ Params: { id: string } }>('/api/board/:id', { preHandler: requireUser }, async (request, reply) => {
    const agent = agentOr404(request.params.id, reply)
    if (agent === null) return reply

    const board = readBoard(agent.workspacePath, `${agent.name} board`)
    return reply.header('cache-control', 'no-store').send({
      agent: { id: agent.id, name: agent.name, preset: agent.preset },
      // Distinguishes "never set up" from "set up but empty", which need
      // different things said to the user.
      initialized: boardSource(agent.workspacePath).present,
      boardDir: BOARD_DIR,
      board,
    })
  })

  /** Server-sent events: one frame whenever an agent rewrites the board data. */
  app.get<{ Params: { id: string } }>('/api/board/:id/events', { preHandler: requireUser }, async (request, reply) => {
    const agent = agentOr404(request.params.id, reply)
    if (agent === null) return reply

    const entry = ensureWatcher(agent, app.log)
    if (entry === null) {
      return reply.code(503).send({ error: 'not_watchable', detail: `${BOARD_DIR}/ does not exist yet` })
    }

    // Written by hand and never ended, so Fastify is told to stop tracking it.
    reply.hijack()

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx and Caddy would otherwise buffer the stream into uselessness.
      'x-accel-buffering': 'no',
    })
    reply.raw.write('retry: 3000\n')
    reply.raw.write(`data: ${JSON.stringify({ kind: 'hello', at: Date.now() })}\n\n`)
    entry.subscribers.add(reply)

    // Phones drop idle sockets, and so do proxies. A comment line is a no-op for
    // the client but keeps the connection open.
    //
    // Exits on `destroyed` rather than on a thrown error: `write` to a dead
    // socket reports through a callback and never throws, so a try/catch here
    // would leak the interval and the subscriber for the life of the process.
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
      entry.subscribers.delete(reply)
    }

    request.raw.on('close', drop)
    request.raw.on('error', drop)
    reply.raw.on('error', drop)
  })
}
