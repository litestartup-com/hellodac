/**
 * 事故回归（2026-09-25 ubuntu-focal 失联）：`public/assets/agent/runtime.mjs`
 * 是**部署到远端工作机的运行时**（不是本仓库的 TS 源码），但它同样是
 * `node:test` 的测试对象——幂等 spawn 与开机自恢复都必须有回归覆盖。
 *
 * 类型面：静态面是纯 ESM 的 .mjs，没有（也不需要）完整的类型定义；测试只需要
 * 构造 AgentRuntime 这一项能力，故只声明用到的最小形状，避免给部署产物背上
 * 一个会漂移的手写类型。
 */
declare module '*/runtime.mjs' {
  export interface RuntimeFs {
    readFile: (p: string) => string | null
    writeFile: (p: string, c: string) => void
    mkdir: (p: string) => void
    exists: (p: string) => boolean
    stat: (p: string) => number | null
    rename: (from: string, to: string) => void
    remove: (p: string) => void
    listDir?: (p: string) => string[] | null
  }

  export interface RuntimeProc {
    install: (agentDir: string, version: string, legacyPeerDeps: boolean) => Promise<string>
    installProfile?: (profileDir: string, legacyPeerDeps: boolean) => Promise<void>
    spawn: (bin: string, args: string[], env: Record<string, string>, outPath: string) => Promise<{ pid: number }>
    kill: (pid: number) => Promise<void>
    alive: (pid: number) => Promise<boolean>
  }

  export interface RuntimeOptions {
    managerUrl: string
    joinToken: string
    agentDir: string
    fs?: RuntimeFs
    proc?: RuntimeProc
    backoff?: (ms: number) => Promise<void>
    log?: (line: string) => void
  }

  export class AgentRuntime {
    constructor(opts: RuntimeOptions)
    nodes: Map<string, { pid: number | null; startedAt: number | null; logOffset: number }>
    agentId: string | null
    agentToken: string | null
    execSpawn(command: { payload?: Record<string, unknown> }): Promise<{ ok: boolean; result: Record<string, unknown> }>
    execStop(command: { payload?: Record<string, unknown> }): Promise<{ ok: boolean; result: Record<string, unknown> }>
    execute(command: { type: string; payload?: Record<string, unknown> }): Promise<{ ok: boolean; result: Record<string, unknown> }>
    resumeNodes(): Promise<string[]>
    loadIdentity(): void
  }

  export const LEGACY_PEER_DEPS_VERSIONS: string[]
  export const NODE_LOG_MAX_BYTES: number
}
