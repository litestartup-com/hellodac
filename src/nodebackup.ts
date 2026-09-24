/**
 * 蜂群2计划 P4：节点 home（会话/settings/技能）备份与恢复。
 *
 * 形态：
 * - 裸机（process runner）→ 节点目录 DSH_HOME 打 tar.gz（排除 node_modules/pidfile）；
 * - 容器（docker runner）→ 命名卷经一次性 alpine 工具容器打 tar.gz；
 * - compose 脊柱的主脑卷等无 spawn 段 → `backup.docker_volumes` 声明。
 *
 * 归档统一加密落盘（AES-256-GCM，债务 A1：密钥 = `BACKUP_KEY` 或 HKDF 派生自
 * SESSION_SECRET；旧 CBC 归档兼容读），保留策略与
 * DB 快照一致（24h 全留 → 每日 30 天 → 每周 12 周）；每节点 6 小时内已有
 * 归档则跳过（会话数据重，15 分钟级全量打包不划算）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { AppConfig } from './config.js'
import type { DockerRunner } from './nodes/docker-runner.js'
import { decryptFile, encryptFile } from './crypt.js'

export interface NodeHomeEntry {
  nodeId: string
  kind: 'dir' | 'docker'
  /** dir = 绝对目录；docker = 命名卷名。 */
  home: string
}

/** 从配置收集节点 home（纯函数，可单测）。 */
export const collectNodeHomes = (config: AppConfig): NodeHomeEntry[] => {
  const entries: NodeHomeEntry[] = []
  for (const [id, ep] of Object.entries(config.endpoints)) {
    const spawn = ep.spawn
    if (spawn === null) continue
    if (spawn.runner === 'process') {
      const home = spawn.env['DSH_HOME']
      if (home !== undefined && home !== '') entries.push({ nodeId: id, kind: 'dir', home })
    } else if (spawn.docker !== null) {
      for (const [volume, containerPath] of Object.entries(spawn.docker.namedVolumes)) {
        if (containerPath === '/data') entries.push({ nodeId: id, kind: 'docker', home: volume })
      }
    }
  }
  // 蜂群2计划 P4：额外 docker 卷（compose 脊柱的主脑卷等）
  for (const volume of config.backupDockerVolumes ?? []) {
    entries.push({ nodeId: basename(volume), kind: 'docker', home: volume })
  }
  return entries
}

const RECENT_MS = 6 * 3_600_000

const stamp = (now: number): string => {
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 某节点的最新归档（无 = null）。 */
export const lastNodeHomeArchive = (dir: string, nodeId: string): { file: string; at: number } | null => {
  if (!existsSync(dir)) return null
  const prefix = `node-${nodeId}-`
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.tar.gz.enc'))
    .map((file) => ({ file, at: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return files[0] ?? null
}

/** 保留策略：24h 全留 → 每节点每日一份 30 天 → 每节点每周一份 12 周。返回被删文件。 */
export const pruneNodeHomeArchives = (dir: string, now = Date.now()): string[] => {
  if (!existsSync(dir)) return []
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  const files = readdirSync(dir)
    .filter((f) => /^node-.+-\d{8}-\d{6}\.tar\.gz\.enc$/.test(f))
    .map((file) => ({ file, at: statSync(join(dir, file)).mtimeMs, nodeId: file.replace(/^node-(.+)-\d{8}-\d{6}\.tar\.gz\.enc$/, '$1') }))
    .sort((a, b) => a.at - b.at)

  const kept = new Set<string>()
  const dayKeys = new Map<string, Set<string>>()
  const weekKeys = new Map<string, Set<string>>()
  for (const f of files) {
    if (now - f.at <= 24 * HOUR) {
      kept.add(f.file)
      continue
    }
    const d = new Date(f.at)
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    let days = dayKeys.get(f.nodeId)
    if (days === undefined) {
      days = new Set()
      dayKeys.set(f.nodeId, days)
    }
    if (!days.has(dayKey)) {
      days.add(dayKey)
      if (now - f.at <= 30 * DAY) {
        kept.add(f.file)
        continue
      }
      const day = d.getDay() === 0 ? 7 : d.getDay()
      const monday = new Date(d)
      monday.setDate(d.getDate() - (day - 1))
      monday.setHours(0, 0, 0, 0)
      const weekKey = String(monday.getTime())
      let weeks = weekKeys.get(f.nodeId)
      if (weeks === undefined) {
        weeks = new Set()
        weekKeys.set(f.nodeId, weeks)
      }
      if (!weeks.has(weekKey) && now - f.at <= 12 * 7 * DAY) {
        weeks.add(weekKey)
        kept.add(f.file)
      }
    }
  }

  const removed: string[] = []
  for (const f of files) {
    if (!kept.has(f.file)) {
      rmSync(join(dir, f.file), { force: true })
      removed.push(f.file)
    }
  }
  return removed
}

/**
 * 打包一个节点 home 到加密归档。返回归档文件名；跳过/失败语义由调用方处理。
 * docker 卷经一次性 alpine 工具容器（镜像缺失自动拉取）。
 * `sessionSecret` 交给 crypt 层按格式派生（v2 = HKDF/`BACKUP_KEY`;v1 兼容读 = legacy）。
 */
export const packNodeHome = async (
  entry: NodeHomeEntry,
  backupDir: string,
  sessionSecret: string,
  dockerRunner: DockerRunner | undefined,
  now = Date.now(),
): Promise<string> => {
  mkdirSync(backupDir, { recursive: true })
  const archive = join(backupDir, `node-${entry.nodeId}-${stamp(now)}.tar.gz.enc`)
  const tarball = join(backupDir, `tmp-${entry.nodeId}-${stamp(now)}.tar.gz`)
  try {
    if (entry.kind === 'dir') {
      if (!existsSync(entry.home)) throw new Error(`node home directory does not exist: ${entry.home}`)
      execFileSync('tar', ['-czf', tarball, '--exclude=profiles/*/node_modules', '--exclude=*.pid', '-C', entry.home, '.'], { stdio: ['ignore', 'ignore', 'pipe'] })
    } else {
      if (dockerRunner === undefined) throw new Error('backing up a docker volume needs docker.sock (is it mounted into the manager?)')
      // 债务 R10：tar 打 stdout（-），manager 经 attach 流收下写 tarball——
      // 只绑命名卷，不把 manager 容器内的备份目录当宿主路径 bind（ENOENT 根因）。
      await dockerRunner.runToolIo(
        'alpine:3.20',
        ['tar', 'czf', '-', '-C', '/data', '.'],
        [{ from: entry.home, to: '/data' }],
        { stdout: tarball },
      )
    }
    await encryptFile(tarball, archive, sessionSecret)
    return basename(archive)
  } finally {
    rmSync(tarball, { force: true })
  }
}

/** 全部节点 home 打包（6 小时内已有归档的节点跳过）。返回打包的归档名。 */
export const packNodeHomes = async (
  entries: NodeHomeEntry[],
  backupDir: string,
  sessionSecret: string,
  dockerRunner: DockerRunner | undefined,
  now = Date.now(),
): Promise<string[]> => {
  const packed: string[] = []
  for (const entry of entries) {
    const last = lastNodeHomeArchive(backupDir, entry.nodeId)
    if (last !== null && now - last.at < RECENT_MS) continue
    packed.push(await packNodeHome(entry, backupDir, sessionSecret, dockerRunner, now))
  }
  pruneNodeHomeArchives(backupDir, now)
  return packed
}

/**
 * 恢复前守卫（评审 B4）：目录形态的恢复会 rm -rf 目标——配置来源的路径可能被
 * 误配为根目录/家目录/备份目录本身，毁掉不可再生的数据。凡是被判「危险」的
 * 目标一律拒绝，宁可恢复失败也不冒删盘风险。
 */
const assertSafeRestoreTarget = (target: string, backupDir: string): void => {
  const abs = resolve(target)
  const backup = resolve(backupDir)
  if (!isAbsolute(target)) throw new Error(`refusing to restore: node home is not an absolute path (${target})`)
  if (abs === resolve(sep) || abs === resolve('.') || abs === resolve(process.env.USERPROFILE ?? process.env.HOME ?? '/')) {
    throw new Error(`refusing to restore: the target is the root, cwd or home directory (${abs}) — DSH_HOME in the config may be wrong`)
  }
  if (abs === backup || abs.startsWith(backup + sep)) {
    throw new Error(`refusing to restore: the target sits inside the backup directory (${abs}) — that would destroy the backup itself`)
  }
}

/**
 * 恢复一个节点 home：解密归档 → tar 解包到目标目录（目录已存在则清空重建）。
 * docker 卷形态经一次性工具容器解包进卷。
 */
export const restoreNodeHome = async (
  entry: NodeHomeEntry,
  archiveFile: string,
  backupDir: string,
  sessionSecret: string,
  dockerRunner: DockerRunner | undefined,
): Promise<void> => {
  // 评审 B4：先守卫后动刀——目标路径危险时在解密/删除任何东西之前就拒绝
  if (entry.kind === 'dir') assertSafeRestoreTarget(entry.home, backupDir)
  const archive = join(backupDir, archiveFile)
  if (!existsSync(archive)) throw new Error(`node home archive not found: ${archiveFile}`)
  const tarball = join(backupDir, `restore-${entry.nodeId}-${Date.now()}.tar.gz`)
  try {
    await decryptFile(archive, tarball, sessionSecret)
    if (entry.kind === 'dir') {
      rmSync(entry.home, { recursive: true, force: true })
      mkdirSync(entry.home, { recursive: true })
      execFileSync('tar', ['-xzf', tarball, '-C', entry.home], { stdio: ['ignore', 'ignore', 'pipe'] })
    } else {
      if (dockerRunner === undefined) throw new Error('restoring a docker volume needs docker.sock')
      // 债务 R10：tarball 经 stdin 流喂给容器内 tar（反向流，同样不 bind 备份目录）。
      await dockerRunner.runToolIo(
        'alpine:3.20',
        ['tar', 'xzf', '-', '-C', '/data'],
        [{ from: entry.home, to: '/data' }],
        { stdin: tarball },
      )
    }
  } finally {
    rmSync(tarball, { force: true })
  }
}
