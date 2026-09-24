import type { FastifyReply, FastifyRequest } from 'fastify'
import { COOKIE_NAME, resolveSession, type SessionUser } from './session.js'
import type { Db } from '../db/index.js'

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: SessionUser
  }
}

/**
 * Rejects with 401 for API routes. Page routes redirect instead -- see
 * `requirePage` -- because a browser hitting a URL should land on the login
 * form, not on a JSON error body.
 */
export const makeRequireUser =
  (db: Db) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = request.cookies[COOKIE_NAME]
    const user = resolveSession(db, token)
    if (user === null) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    // 蜂群2计划 P3：强制改密期间，除「自身信息 / 登出 / 改密」外的 API 一律 403
    if (user.mustChangePassword) {
      const url = (request.url ?? '').split('?')[0] ?? ''
      const allowed = url === '/api/me' || url === '/api/logout' || url === '/api/account/password'
      if (!allowed) {
        await reply.code(403).send({ error: 'password_change_required' })
        return
      }
    }
    request.currentUser = user
  }

export const makeRequirePage =
  (db: Db) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = request.cookies[COOKIE_NAME]
    const user = resolveSession(db, token)
    if (user === null) {
      await reply.redirect('/login', 302)
      return
    }
    request.currentUser = user
  }
