/**
 * The SessionDriver port (the first item of the road-building stage, decided in TRANSLATOR-OPTIONS §5 on 2026-09-09).
 *
 * The layer above (runner / chat / status / nodes / provision / cron) depends only on this port, not on any particular
 * translator. Plug one = the facade driver (UpstreamClient, the HTTP facade contract); plug two = the ACP narrow bridge;
 * plug three = MQTT (the tens-of-thousands shape). **Swapping plugs = swapping implementations, with zero change above**
 * -- that is the entire reason this module exists, and any new code that leaks wire details upwards violates the port.
 *
 * Port vocabulary (nine operations + one optional capability):
 * create / prompt / subscribe / history / cancel / ask / approve / release / probe
 * + setSandboxMode (a facade-line capability that future plugs may skip; the layer above checks as needed).
 *
 * Semantics:
 * - release is a no-op for plug one (the facade) -- the host owns the sessions and the manager has no slot to give
 *   back (the old gateway driver's maxSessions slot model has nothing to do with the port); plugs such as ACP that
 *   own a child process really do release here.
 * - probeVersion must **throw** on failure so the caller's catch can call it "unreachable"; the return value is the
 *   version string (for display only, never for a compatibility warning -- DSH-FACTS §6).
 */
import type { MuxListener } from '../upstream/mux.js'
import type { UpstreamCreatedSession, UpstreamModelCatalog, UpstreamModelSelection, UpstreamSessionHistory } from '../upstream/client.js'
import type { RpcReceipt } from '../upstream/respond.js'
import type { GatewayFrame } from '../gateway/stream.js'

export interface SessionDriver {
  /** Endpoint id (the key in the manager config). */
  readonly id: string
  /** Create a chat: cwd = the workspace, preset = the agent preset; returns the chat facts. */
  createSession(cwd: string, preset?: string | null): Promise<UpstreamCreatedSession>
  /** Send a message (also wakes/continues a cold chat). */
  prompt(sessionId: string, text: string): Promise<{ accepted: boolean }>
  /** Subscribe to a chat's live frames; returns the unsubscribe function. */
  subscribe(sessionId: string, listener: MuxListener): () => void
  /** Read the history (frames + projection + title). */
  history(sessionId: string): Promise<UpstreamSessionHistory>
  modelCatalog?(): Promise<UpstreamModelCatalog>
  selectModel?(sessionId: string, selection: UpstreamModelSelection): Promise<UpstreamModelSelection>
  /** Cancel the current turn. */
  cancel(sessionId: string): Promise<void>
  /** Answer a question; rpcId = the reply id of that question frame. */
  answerQuestion(rpcId: string, sessionId: string, answer: unknown): Promise<RpcReceipt>
  /** Decline a question (wire semantics = claiming it as cancelled). */
  declineQuestion(rpcId: string, sessionId: string): Promise<RpcReceipt>
  /** Approval decision; the outcome vocabulary is allowed-once | rejected. */
  decideApproval(
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<RpcReceipt>
  /** Release a chat; a no-op for plug one, which has no slot to give back. */
  release(sessionId: string): Promise<void>
  /** Liveness probe: returns the version string; must throw on failure. */
  probeVersion(): Promise<string>
  canSetSandboxMode?(): boolean
  /** Pin the sandbox mode per chat (a facade-line capability; optional). danger-full-access requires the node to
   *  unlock allowFullAccess, and the facade refuses without it -- the layer above checks via allowsFullAccess first. */
  setSandboxMode?(sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void>
  /** Whether the node has unlocked the full-access sandbox (allowFullAccess from host.describe); missing implementation = unsupported. */
  allowsFullAccess?(): Promise<boolean>
  /**
   * Card chain (2026-09-17): fetch the question/approval frames the host still has pending (question/approval are
   * broadcast only once, so this recovers them after a disconnect window or a manager restart). A missing
   * implementation (old plug / unsupported) = no recovery ability, treated as empty by the layer above; a failure
   * must throw for the caller to catch (a failed recovery must not block the main flow).
   */
  pendingAsks?(sessionId: string): Promise<GatewayFrame[]>
}
