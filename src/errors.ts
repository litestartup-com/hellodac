/**
 * 债务 E6:错误 → 用户可读文本的唯一映射。
 * 原 4 处各写各的三元链(GatewayError.detail / UpstreamError.message / String),
 * 语义还不一致(runner 无 detail 兜底、status 有)。此后全项目只此一处。
 */
import { GatewayError } from './gateway/client.js'
import { UpstreamError } from './upstream/rpc.js'

export const errorText = (error: unknown): string => {
  if (error instanceof GatewayError) return error.detail || error.message
  if (error instanceof UpstreamError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
