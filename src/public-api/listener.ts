/**
 * 对外门面监听器（设计稿：内部设计库 `manager/topics/public-api.md` §3）。
 *
 * **与后台分两扇门**：独立 Fastify 实例、独立端口、默认只绑 `127.0.0.1`。
 * 这里刻意不装 cookie / 静态资源 / 安全头中间件——门面只出 JSON，且不认会话 cookie，
 * 因此"反代配错把整个后台暴露出去"这条路从结构上就被堵住。
 *
 * 失败语义（企业级取舍）：**门面起不来绝不能拖垮 manager 主服务**。绑定失败时记
 * error 日志 + 落一份可查询的状态（管理界面与排障都看它），主服务照常运行：
 * "API 不见了"比"整站挂了"好，而"API 悄悄不见了"最糟——所以状态必须可见。
 */
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { registerPublicApiRoutes } from './routes.js'

export interface PublicApiState {
  status: 'disabled' | 'listening' | 'failed'
  host: string
  port: number
  detail: string | null
}

const DEFAULT_SETTINGS = { enabled: true, host: '127.0.0.1', port: 8081 }

let state: PublicApiState = { status: 'disabled', host: DEFAULT_SETTINGS.host, port: DEFAULT_SETTINGS.port, detail: null }

/** 供管理界面/状态页读取：门面到底起没起、为什么没起。 */
export const getPublicApiState = (): PublicApiState => state

export interface StartPublicApiDeps {
  config: AppConfig
  db: Db
  log: (line: string, level?: 'info' | 'error') => void
}

/** 统一构建（测试用 `port: 0` 拿随机端口，或直接 inject 路由而不监听）。 */
export const buildPublicApiApp = (deps: { config: AppConfig; db: Db }): FastifyInstance => {
  const app = Fastify({
    logger: false,
    trustProxy: deps.config.trustProxy ?? false,
    // 对外面不接受大包：P0 的任务面只有文本输入（附件是 v1.1 的事）。
    bodyLimit: 1_000_000,
    disableRequestLogging: true,
  })
  // 监听器级兜底限流：按 IP 计数，挡住"拿假钥匙狂刷"这类流量（审计不记它们，
  // 见 routes.ts 的策略说明）。每把钥匙自己的额度由钥匙表的 rateLimitRpm 管（P1）。
  void app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' })
  registerPublicApiRoutes(app, deps)
  return app
}

/**
 * 起门面。返回 null 表示"没有门面"（被配置关闭或绑定失败）——调用方无需分支，
 * 只要在关闭时 `await handle?.close()`。
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
