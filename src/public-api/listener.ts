/**
 * The outward listener (design: internal design library `manager/topics/public-api.md` §3).
 *
 * **Two doors, not one**: a separate Fastify instance, its own port, bound to `127.0.0.1` by default.
 * Deliberately no cookie plugin, no static assets and no security-header middleware: this door speaks
 * JSON only and does not accept session cookies, so "a misconfigured reverse proxy exposed the whole
 * admin UI" is structurally impossible.
 *
 * Failure semantics (an enterprise trade-off): **a door that cannot bind must never take the manager
 * down**. A bind failure logs an error and records a queryable state (the admin UI and troubleshooting
 * both read it) while the main service keeps running: "the API is gone" beats "everything is down",
 * and "the API quietly disappeared" is worst of all -- hence the state has to be visible.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { registerPublicApiRoutes, type PublicApiPorts } from './routes.js'

export interface PublicApiState {
  status: 'disabled' | 'listening' | 'failed'
  host: string
  port: number
  detail: string | null
}

const DEFAULT_SETTINGS = { enabled: true, host: '127.0.0.1', port: 8081 }

let state: PublicApiState = { status: 'disabled', host: DEFAULT_SETTINGS.host, port: DEFAULT_SETTINGS.port, detail: null }

/** Read by the admin UI/status page: whether the door is up, and why not. */
export const getPublicApiState = (): PublicApiState => state

export interface StartPublicApiDeps {
  config: AppConfig
  db: Db
  log: (line: string, level?: 'info' | 'error') => void
  /** What the conversation surface needs (liveness + run a turn), injected by the wiring layer;
   * absent = the read-only surface only. */
  ports?: PublicApiPorts
}

/** One builder for both uses (tests pass `port: 0` for a random port, or inject without listening). */
export const buildPublicApiApp = (deps: { config: AppConfig; db: Db; ports?: PublicApiPorts }): FastifyInstance => {
  const app = Fastify({
    logger: false,
    trustProxy: deps.config.trustProxy ?? false,
    // This door does not accept large bodies: the task surface takes text input only.
    bodyLimit: 1_000_000,
    disableRequestLogging: true,
  })
  // Listener-level safety net: counted per IP to absorb "spray with fake keys" traffic (the audit
  // skips those, see routes.ts). A key's own budget is enforced by its rateLimitRpm.
  void app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' })
  registerPublicApiRoutes(app, deps)
  return app
}

/**
 * Start the door. Returning null means "no door" (disabled by config, or the bind failed) -- callers
 * need no branch, they just `await handle?.close()` on shutdown.
 */
export const startPublicApi = async (deps: StartPublicApiDeps): Promise<{ close: () => Promise<void> } | null> => {
  const settings = deps.config.publicApi ?? DEFAULT_SETTINGS
  if (!settings.enabled) {
    state = { status: 'disabled', host: settings.host, port: settings.port, detail: 'disabled by config (public_api.enabled: false)' }
    deps.log('public API listener disabled by config')
    return null
  }

  const app = buildPublicApiApp(deps)
  try {
    await app.listen({ host: settings.host, port: settings.port })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    state = { status: 'failed', host: settings.host, port: settings.port, detail }
    deps.log(`public API listener could not bind ${settings.host}:${settings.port} — ${detail}. The admin UI keeps running.`, 'error')
    await app.close().catch(() => undefined)
    return null
  }

  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : settings.port
  state = { status: 'listening', host: settings.host, port, detail: null }
  deps.log(`public API listening on http://${settings.host}:${port}/v1 (keys required; no session cookies accepted)`)
  return { close: () => app.close() }
}
