// @ts-check
/**
 * 能力四（舰队 M1-5/M4-3）：node-agent 入口。
 * 环境变量：MANAGER_URL（manager 基址）、AGENT_JOIN_TOKEN（一次性注册 token）、
 * AGENT_DIR（工作目录，默认 ~/.dac-agent）。
 * 由 join.sh / join.ps1 安装为常驻服务（systemd user unit / Windows 计划任务）。
 *
 * M4-3：先做自更新换装/回滚（纯 fs，见 update.mjs），再动态加载 runtime——
 * 保证「新代码生效前已原子换装」，秒崩自动回滚上一代。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyPendingUpdate } from './update.mjs'

const managerUrl = process.env.MANAGER_URL ?? ''
const joinToken = process.env.AGENT_JOIN_TOKEN ?? ''
const agentDir = process.env.AGENT_DIR ?? join(homedir(), '.dac-agent')

if (managerUrl === '' || joinToken === '') {
  console.error('[node-agent] MANAGER_URL 与 AGENT_JOIN_TOKEN 必填（join.sh 生成时注入）')
  process.exit(1)
}

applyPendingUpdate(agentDir)

const { AgentRuntime } = await import('./runtime.mjs')
const runtime = new AgentRuntime({ managerUrl, joinToken, agentDir })
await runtime.run()
