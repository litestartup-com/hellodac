// @ts-check
/**
 * 能力四（舰队 M4-3）：agent 原子自更新——只用 node:fs，在入口 import
 * runtime 之前调用（新代码生效前必须先换装）。
 *
 * 布局（AGENT_DIR 下）：
 * - .next/        待应用的新文件（agent.mjs + runtime.mjs + .version）——
 *                 execUpdate 校验后 staging，入口启动时原子换装；
 * - .prev/        上一代文件（回滚源，保留一代）；
 * - .update-version  当前运行版本串（版本协商上报用）；
 * - .update-at    最近一次换装时间戳（秒崩回滚判定用）；
 * - .last-boot    上次启动时间戳（本次启动写入；间隔 <90s 且换装 <10min
 *                 内 = 新代码秒崩循环（计划任务 60s 重启间隔）→ 回滚）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export const NEXT_DIR = '.next'
export const PREV_DIR = '.prev'
export const UPDATE_VERSION_FILE = '.update-version'
export const UPDATE_AT_FILE = '.update-at'
export const BOOT_MARKER = '.last-boot'
/** 自更新承载的运行时文件（换装/回滚都按这张清单走）。 */
export const RUNTIME_FILES = ['agent.mjs', 'runtime.mjs', 'update.mjs']
/** 秒崩判定：两次启动间隔小于该值且换装发生在 10 分钟内 = 回滚。 */
export const CRASH_GAP_MS = 90_000
export const UPDATE_AGE_MS = 10 * 60_000

const readTs = (path) => {
  try {
    const n = Number(readFileSync(path, 'utf8').trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

const renameBack = (prevDir, agentDir, log) => {
  for (const name of RUNTIME_FILES) {
    if (!existsSync(`${prevDir}/${name}`)) continue
    rmSync(`${agentDir}/${name}`, { force: true })
    renameSync(`${prevDir}/${name}`, `${agentDir}/${name}`)
  }
  rmSync(prevDir, { recursive: true, force: true })
  log('[node-agent] 已回滚到上一代（新代码秒崩判定）')
}

/**
 * 启动期调用：先判回滚，再应用挂起的 .next。返回 { updated }。
 * @param {string} agentDir
 * @param {(line: string) => void} [log]
 */
export const applyPendingUpdate = (agentDir, log = () => {}) => {
  const nextDir = `${agentDir}/${NEXT_DIR}`
  const prevDir = `${agentDir}/${PREV_DIR}`
  const updateAtPath = `${agentDir}/${UPDATE_AT_FILE}`
  const bootMarker = `${agentDir}/${BOOT_MARKER}`

  // 1) 秒崩回滚判定（先于任何换装）
  const updatedAt = readTs(updateAtPath)
  const lastBoot = readTs(bootMarker)
  if (updatedAt !== null && lastBoot !== null && Date.now() - updatedAt < UPDATE_AGE_MS && Date.now() - lastBoot < CRASH_GAP_MS && existsSync(`${prevDir}/agent.mjs`)) {
    renameBack(prevDir, agentDir, log)
    rmSync(updateAtPath, { force: true })
    rmSync(`${agentDir}/${UPDATE_VERSION_FILE}`, { force: true })
  }
  writeFileSync(bootMarker, String(Date.now()), 'utf8')

  // 2) 应用挂起的 .next（原子换装：当前 → .prev，.next → 当前）
  if (existsSync(nextDir)) {
    try {
      mkdirSync(prevDir, { recursive: true })
      for (const name of RUNTIME_FILES) {
        if (existsSync(`${agentDir}/${name}`)) {
          rmSync(`${prevDir}/${name}`, { force: true })
          renameSync(`${agentDir}/${name}`, `${prevDir}/${name}`)
        }
      }
      for (const name of RUNTIME_FILES) {
        if (existsSync(`${nextDir}/${name}`)) renameSync(`${nextDir}/${name}`, `${agentDir}/${name}`)
      }
      const version = existsSync(`${nextDir}/.version`) ? readFileSync(`${nextDir}/.version`, 'utf8').trim() : ''
      rmSync(nextDir, { recursive: true, force: true })
      if (version !== '') writeFileSync(`${agentDir}/${UPDATE_VERSION_FILE}`, version, 'utf8')
      writeFileSync(updateAtPath, String(Date.now()), 'utf8')
      log(`[node-agent] 自更新已应用${version !== '' ? `（→ ${version}）` : ''}，请由服务管理器重启加载新代码`)
    } catch (error) {
      log(`[node-agent] 自更新换装失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { updated: existsSync(updateAtPath) && Date.now() - (readTs(updateAtPath) ?? 0) < 60_000 }
}

/** 当前运行版本串（版本协商上报用；无 = null）。 */
export const currentAgentVersion = (agentDir) => {
  try {
    const v = readFileSync(`${agentDir}/${UPDATE_VERSION_FILE}`, 'utf8').trim()
    return v === '' ? null : v
  } catch {
    return null
  }
}
