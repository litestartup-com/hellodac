/**
 * SessionDriver 端口（修路阶段第一项，TRANSLATOR-OPTIONS §5 拍板 2026-09-09）。
 *
 * 上层（runner / chat / status / nodes / provision / cron）只依赖这个端口，
 * 不依赖任何具体翻译员。插头一 = facade 驱动（UpstreamClient，HTTP 门面契约）；
 * 插头二 = ACP 窄桥；插头三 = MQTT（万级形态）。**换插头 = 换实现，上层零改动**
 * ——这是本模块存在的全部理由，任何把 wire 细节漏进上层的新代码都是违反端口。
 *
 * 端口词汇（九操作 + 一个可选能力）：
 * 建会话 / 发消息 / 订阅 / 历史 / 取消 / 问答 / 审批 / 释放 / 探活
 * + setSandboxMode（facade 线能力，未来插头可不实现，上层按需检查）。
 *
 * 语义说明：
 * - release 对插头一（facade）是 no-op——会话由宿主持有，manager 无槽位可还
 *   （旧 gateway 驱动的 maxSessions 槽位模型与端口无关）；ACP 等自持子进程
 *   资源的插头在这里做真释放。
 * - probeVersion 失败必须**抛出**，让上层的 catch 判「不可达」；返回值是
 *   版本串（只作信息展示，绝不用于兼容性告警——DSH-FACTS §6）。
 */
import type { MuxListener } from '../upstream/mux.js'
import type { UpstreamCreatedSession, UpstreamModelCatalog, UpstreamModelSelection, UpstreamSessionHistory } from '../upstream/client.js'
import type { RpcReceipt } from '../upstream/respond.js'
import type { GatewayFrame } from '../gateway/stream.js'

export interface SessionDriver {
  /** 端点 id（manager 配置里的 key）。 */
  readonly id: string
  /** 建会话：cwd = 工作区、preset = agent 预设；返回会话事实。 */
  createSession(cwd: string, preset?: string | null): Promise<UpstreamCreatedSession>
  /** 发消息（兼冷会话唤醒/续接）。 */
  prompt(sessionId: string, text: string): Promise<{ accepted: boolean }>
  /** 订阅一个会话的直播帧；返回退订函数。 */
  subscribe(sessionId: string, listener: MuxListener): () => void
  /** 读历史（帧 + 投影 + 标题）。 */
  history(sessionId: string): Promise<UpstreamSessionHistory>
  modelCatalog?(): Promise<UpstreamModelCatalog>
  selectModel?(sessionId: string, selection: UpstreamModelSelection): Promise<UpstreamModelSelection>
  /** 取消当前回合。 */
  cancel(sessionId: string): Promise<void>
  /** 回答问题；rpcId = 该问题帧的应答标识。 */
  answerQuestion(rpcId: string, sessionId: string, answer: unknown): Promise<RpcReceipt>
  /** 拒绝问题（wire 语义 = 认领为 cancelled）。 */
  declineQuestion(rpcId: string, sessionId: string): Promise<RpcReceipt>
  /** 审批决策；outcome 词汇 allowed-once | rejected。 */
  decideApproval(
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<RpcReceipt>
  /** 释放会话；插头一无槽位时实现为 no-op。 */
  release(sessionId: string): Promise<void>
  /** 探活：返回版本串；失败必须抛出。 */
  probeVersion(): Promise<string>
  canSetSandboxMode?(): boolean
  /** 按会话钉沙箱模式（facade 线能力；可选）。danger-full-access 需节点开锁
   *  allowFullAccess，未开锁时 facade 拒绝——上层先经 allowsFullAccess 检查。 */
  setSandboxMode?(sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void>
  /** 节点是否开锁全量沙箱（host.describe 的 allowFullAccess）；缺实现 = 不支持。 */
  allowsFullAccess?(): Promise<boolean>
  /**
   * 卡片链(2026-09-17):取回宿主仍挂起的问答/授权帧(question/approval 只广播
   * 一次,断线窗口/manager 重启后经此恢复)。缺实现(旧插头/不支持) = 无恢复
   * 能力,上层按空处理;失败必须抛出让上层 catch(恢复失败不阻断主流程)。
   */
  pendingAsks?(sessionId: string): Promise<GatewayFrame[]>
}
