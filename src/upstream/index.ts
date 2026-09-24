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
// 修路阶段：端口是上层唯一依赖面；从这里再出口，方便单一 import 点。
export type { SessionDriver } from '../session-driver/port.js'
