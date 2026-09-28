export { rpc, isMethodAllowed, UpstreamError, type UpstreamEndpoint, type RpcOk, type RpcError } from './rpc.js'
export { respond, type RpcReceipt } from './respond.js'
export {
  eventPayload, mapEvents, muxFrameToEvent, muxFrameToGatewayFrame,
  createSessionParams, promptParams, cancelParams, historyParams, listSessionsParams,
  extractProjectionUsage, extractProjectionTitle,
  questionRequestedFrame, questionResolvedFrame, approvalRequestedFrame, approvalResolvedFrame,
  unwrapHistoryEvents, mapSessionList,
  type MuxFrame, type SessionSummary,
} from './translate.js'
export {
  subscribe, closeAllMux, waitForFrame, muxUrl,
  type MuxListener,
} from './mux.js'
export {
  UpstreamClient, buildUpstreamClients,
  type UpstreamSessionHistory, type UpstreamCreatedSession,
} from './client.js'
// Repair phase: the port is the only surface the layers above depend on; re-exported from here for a single import point.
export type { SessionDriver } from '../session-driver/port.js'
