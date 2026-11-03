import { eq } from 'drizzle-orm'
import type { AppConfig } from './config.js'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'
import type { SessionDriver } from './session-driver/port.js'

/**
 * The single decide path for a pending permission prompt (headless approval, design doc
 * hive/topics/headless-approval-p1.md). Both doors share it -- the internal brain-token endpoint and
 * the user-facing web endpoint -- so the two can never drift: invalid outcome is 400, an unknown
 * decision id 404, an already-decided prompt 409, a run without a session 409, an unconfigured
 * endpoint 500, a refused upstream decision 502. Nothing is auto-approved.
 *
 * Returns an HTTP-shaped result rather than throwing: every branch is an explicit answer the route
 * hands back verbatim.
 */
export const decidePendingApproval = async (
  db: Db,
  config: AppConfig,
  upstreamClients: Map<string, SessionDriver>,
  decisionId: string,
  outcome: unknown,
  actor: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  if (outcome !== 'allowed-once' && outcome !== 'rejected') {
    return { status: 400, body: { error: 'invalid_outcome' } }
  }
  const row = db.select().from(schema.approvalQueue).where(eq(schema.approvalQueue.id, decisionId)).all()[0]
  if (row === undefined) return { status: 404, body: { error: 'unknown_approval' } }
  if (row.state !== 'pending') return { status: 409, body: { error: 'already_decided' } }
  const run = db.select().from(schema.run).where(eq(schema.run.id, row.runId)).all()[0]
  if (run === undefined || run.dshSessionId === null) {
    return { status: 409, body: { error: 'no_session' } }
  }
  const agent = config.agents[row.agentId]
  if (agent === undefined) return { status: 404, body: { error: 'unknown_agent' } }
  const upstream = upstreamClients.get(agent.endpoint)
  if (upstream === undefined) return { status: 500, body: { error: 'endpoint_not_configured' } }
  try {
    await upstream.decideApproval(decisionId, run.dshSessionId, row.approvalId, outcome)
  } catch (error) {
    return { status: 502, body: { error: 'decide_failed', detail: (error as Error).message } }
  }
  db.update(schema.approvalQueue)
    .set({ state: 'resolved', outcome, resolvedAt: Date.now() })
    .where(eq(schema.approvalQueue.id, decisionId))
    .run()
  db.insert(schema.auditLog)
    .values({
      at: Date.now(),
      actor,
      kind: 'approval_decide',
      detail: JSON.stringify({ decisionId, agentId: row.agentId, outcome }),
    })
    .run()
  return { status: 200, body: { ok: true, outcome } }
}
