/**
 * The admin-side config editor for outward services (port 8080, behind `requireUser`).
 *
 * This is the missing middle of the operator flow: the declaration lives in `manager.config.yaml`, but
 * "edit a YAML file over SSH and restart" is not a product. These routes let the UI **preview and
 * validate** a declaration before anything is written, apply it through the comment-preserving atomic
 * writer, and report whether a restart is needed.
 *
 * The split is deliberate: **preview is free and harmless** (it renders to a temp file and asks the
 * real loader), so the UI can show the exact YAML, the diff and the loader's own verdict while the
 * operator types. Applying re-validates under the config lock.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../audit.js'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { reconcileAll } from '../reconcile/index.js'
import { applyService, deleteService, previewService, serviceEditorContext, type ServiceDraft } from '../services/config-edit.js'
import type { ReconcileContext } from '../reconcile/index.js'

const draftSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'the id must be a lowercase slug (a-z, 0-9, -)'),
  label: z.string().min(1).max(80),
  workers: z.array(z.string().min(1)).min(1, 'a service needs at least one agent'),
  surfaces: z.array(z.enum(['tasks', 'conversations'])).min(1),
  permission: z.enum(['read', 'write']),
  session_idle_hours: z.number().positive().max(24 * 365),
  placement: z.enum(['spread', 'pack', 'pin']),
  machines: z.array(z.string().min(1)).default([]),
  max_agents_per_machine: z.number().int().min(1).max(64),
  capacity: z.object({ max_sessions_per_agent: z.number().int().min(1).max(64) }),
  // Not editable in the form, but a declaration on disk may carry it -- it must round-trip.
  thresholds: z
    .object({
      min_free_cpu_percent: z.number().min(0).max(100).optional(),
      min_free_mem_bytes: z.number().nonnegative().optional(),
      min_free_disk_bytes: z.number().nonnegative().optional(),
    })
    .optional(),
  knowledge: z
    .array(z.object({ host: z.string().min(1), mount: z.string().startsWith('/'), read_only: z.boolean() }))
    .default([]),
})

const applyLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } } as const

export interface ServiceEditorDeps {
  config: AppConfig
  db: Db
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  /** The reconcile context, so a membership change converges the registry/fleet like any other config change. */
  reconcile: ReconcileContext
  configPath?: string
}

export const registerServiceEditorRoutes = (app: FastifyInstance, deps: ServiceEditorDeps): void => {
  const configPath = deps.configPath ?? deps.config.configPath ?? 'manager.config.yaml'

  /** What the editor renders: declarations, the candidate agent pool (with reasons), machines. */
  app.get('/api/config/services', { preHandler: deps.requireUser }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(serviceEditorContext({ config: deps.config, configPath })),
  )

  /**
   * Validate a declaration without writing anything. The loader's verdict comes back verbatim: an
   * operator who gets a rejection gets the same sentence the manager would print at boot.
   */
  app.post('/api/config/services/preview', { preHandler: deps.requireUser }, async (request, reply) => {
    const parsed = draftSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.send({ ok: false, yaml: '', diff: [], errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`), warnings: [], resolved: null })
    }
    return reply.send(previewService({ config: deps.config, configPath, draft: parsed.data as ServiceDraft }))
  })

  /** Write it. Re-validated under the lock; a stale `configHash` is refused rather than merged over. */
  app.post('/api/config/services', { preHandler: deps.requireUser, config: applyLimit }, async (request, reply) => {
    const body = request.body as { draft?: unknown; configHash?: unknown } | null
    const parsed = draftSchema.safeParse(body?.draft)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message).join('; ') })
    }
    const actor = request.currentUser?.username ?? 'unknown'
    try {
      const result = await applyService({
        config: deps.config,
        configPath,
        draft: parsed.data as ServiceDraft,
        ...(typeof body?.configHash === 'string' ? { expectHash: body.configHash } : {}),
      })
      if (!result.ok) return reply.code(409).send({ error: 'rejected', detail: result.errors.join('\n') })

      // The registry/fleet are derived from the config, so the same converge entry every other config
      // change uses runs here too (no second path). sweepIdle is off: nothing about a declaration edit
      // should archive a conversation.
      await reconcileAll(deps.reconcile, { onlyNodes: new Set(), removeStaleAgents: false, sweepIdle: false })

      recordAudit(deps.db, {
        actor,
        kind: 'service_applied',
        detail: `service ${parsed.data.id} workers=[${parsed.data.workers.join(', ')}] permission=${parsed.data.permission} capacity=${parsed.data.capacity.max_sessions_per_agent}/agent idle=${parsed.data.session_idle_hours}h placement=${parsed.data.placement}`,
      })

      // A declaration edit is fully live: members are already running processes (auto-provisioning does
      // not exist), the sandbox mode is pinned per session at creation, and the dispatcher reads the
      // in-memory config. Say so plainly instead of the old blanket "restart to apply".
      return reply.send({ ok: true, resolved: result.resolved, warnings: result.warnings, changed: result.changed, restartRequired: false })
    } catch (error) {
      // mutateYamlFile restores the previous version before throwing, so this is 'nothing was written'.
      return reply.code(400).send({ error: 'write_rejected', detail: error instanceof Error ? error.message : String(error) })
    }
  })

  /** Remove a service declaration. Live immediately, same atomic write + rollback pipeline as apply. */
  app.delete<{ Params: { id: string } }>('/api/config/services/:id', { preHandler: deps.requireUser, config: applyLimit }, async (request, reply) => {
    const actor = request.currentUser?.username ?? 'unknown'
    try {
      const removed = await deleteService({ config: deps.config, configPath, id: request.params.id })
      if (removed === null) return reply.code(404).send({ error: 'unknown_service' })
      await reconcileAll(deps.reconcile, { onlyNodes: new Set(), removeStaleAgents: false, sweepIdle: false })
      recordAudit(deps.db, { actor, kind: 'service_deleted', detail: `service ${removed} removed from the declaration` })
      return reply.send({ ok: true, removed, restartRequired: false })
    } catch (error) {
      return reply.code(400).send({ error: 'write_rejected', detail: error instanceof Error ? error.message : String(error) })
    }
  })
}
