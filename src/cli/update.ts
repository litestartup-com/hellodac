import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { backupNow } from '../backup.js'
import { loadConfig } from '../config.js'

/**
 * 蜂群 P6：`npm run update` —— manager 自更新（备份 → 拉新 → 构建 → 探活，
 * 探活失败自动回滚到更新前的提交并重建）。
 *
 * 前提：manager 已停止（更新期间会短暂拉起一个探活实例）；工作树干净
 * （配置与 .env 都在 .gitignore 里，不该脏）；git 远程可用且当前分支
 * 跟踪远程（fast-forward）。
 */

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface UpdateDeps {
  git: (args: string[], cwd: string) => string
  run: (cmd: string, args: string[], cwd: string) => void
  npm: (args: string[], cwd: string) => void
  probe: (port: number, timeoutMs: number) => Promise<boolean>
  backup: () => Promise<string>
  log: (line: string) => void
  startProbeInstance: () => { stop: () => void }
}

export interface UpdateResult {
  ok: boolean
  detail: string
  from?: string
  to?: string
  snapshot?: string
}

export const updateManager = async (deps: UpdateDeps, rootDir: string): Promise<UpdateResult> => {
  // 0. 工作树必须干净——未提交的改动会被 hard-reset 吞掉（配置在 .gitignore，
  //    不该出现在这里；真出现说明有事）。
  const dirty = deps.git(['status', '--porcelain'], rootDir).trim()
  if (dirty !== '') {
    return { ok: false, detail: `the working tree has uncommitted changes — commit or revert them before updating.\n${dirty.split('\n').slice(0, 5).join('\n')}` }
  }

  const oldHead = deps.git(['rev-parse', 'HEAD'], rootDir).trim()
  let snapshot: string | null = null
  try {
    snapshot = await deps.backup()
    deps.log(`backup: ${snapshot}`)
  } catch (error) {
    return { ok: false, detail: `the pre-update backup failed, aborting (the database is untouched): ${(error as Error).message}` }
  }

  try {
    deps.git(['fetch', 'origin'], rootDir)
  } catch (error) {
    return { ok: false, detail: `git fetch failed (remote unreachable?): ${(error as Error).message.split('\n')[0]}` }
  }

  try {
    deps.git(['pull', '--ff-only'], rootDir)
  } catch (error) {
    return { ok: false, detail: `git pull failed (diverged — needs a human): ${(error as Error).message.split('\n')[0]}` }
  }

  const newHead = deps.git(['rev-parse', 'HEAD'], rootDir).trim()
  if (newHead === oldHead) {
    return { ok: true, detail: 'already up to date.', from: oldHead, to: newHead, snapshot }
  }

  const build = (): void => {
    deps.npm(['install'], rootDir)
    deps.npm(['run', 'build'], rootDir)
  }
  try {
    build()
  } catch (error) {
    // 构建失败也回滚——半新的 dist 不该留在原地。
    deps.git(['reset', '--hard', oldHead], rootDir)
    try {
      build()
    } catch {
      // 回滚构建也失败：代码已还原，dist 可能不匹配——如实报告。
    }
    return { ok: false, detail: `the build failed; code rolled back to ${oldHead.slice(0, 8)} (dist may need a manual npm run build). ${(error as Error).message.split('\n')[0]}`, from: oldHead, to: newHead, snapshot }
  }

  // 探活：短暂拉起一个实例，端口通了才算数。
  const instance = deps.startProbeInstance()
  const alive = await deps.probe(8080, 30_000)
  instance.stop()

  if (alive) {
    return { ok: true, detail: `update complete: ${oldHead.slice(0, 8)} → ${newHead.slice(0, 8)}. Restart the manager (service or manual) to apply it.`, from: oldHead, to: newHead, snapshot }
  }

  deps.git(['reset', '--hard', oldHead], rootDir)
  try {
    build()
  } catch {
    // 同上：代码已还原，dist 可能不匹配。
  }
  return { ok: false, detail: `the new version failed its 30-second health probe; rolled back to ${oldHead.slice(0, 8)} and rebuilt.`, from: oldHead, to: newHead, snapshot }
}

/** 真实依赖（CLI 直跑用）。 */
const realDeps = (rootDir: string): UpdateDeps => {
  const git = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const run = (cmd: string, args: string[], cwd: string): void => {
    execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npm = (args: string[], cwd: string): void => {
    execFileSync(npmCmd, args, { cwd, shell: true, stdio: ['ignore', 'inherit', 'inherit'] })
  }
  const probe = (port: number, timeoutMs: number): Promise<boolean> =>
    new Promise((done) => {
      const started = Date.now()
      const attempt = (): void => {
        const socket = new net.Socket()
        socket.setTimeout(1_000)
        socket.once('connect', () => {
          socket.destroy()
          done(true)
        })
        socket.once('error', () => socket.destroy())
        socket.once('timeout', () => socket.destroy())
        socket.once('close', () => {
          if (Date.now() - started > timeoutMs) done(false)
          else setTimeout(attempt, 1_000)
        })
        socket.connect(port, '127.0.0.1')
      }
      attempt()
    })
  const backup = async (): Promise<string> => {
    // 债务 R3:备份路径只来自一次成功的 loadConfig——自定义 database.path /
    // 部署布局不再备错文件;配置不可读时显性失败(更新前配置必须健康)。
    const cfg = loadConfig()
    const result = await backupNow(
      cfg.databasePath,
      cfg.configPath ?? resolve(rootDir, 'manager.config.yaml'),
      cfg.envPath ?? resolve(rootDir, '.env'),
      join(dirname(cfg.databasePath), 'backups'),
      cfg.sessionSecret,
    )
    return result.snapshot.file
  }
  const startProbeInstance = (): { stop: () => void } => {
    const child = spawn(process.execPath, [join(rootDir, 'dist', 'index.js')], {
      cwd: rootDir,
      env: { ...process.env, DSH_PERMISSION_MODE: 'read-only' },
      stdio: 'ignore',
      windowsHide: true,
    })
    return {
      stop: () => {
        try {
          child.kill()
        } catch {
          // 进程可能已经退出
        }
      },
    }
  }
  return { git, run, npm, probe, backup, startProbeInstance, log: (line) => console.log(line) }
}

const main = async (): Promise<void> => {
  const root = resolve(here)
  const deps = realDeps(root)

  // manager 正在跑时不能更新（探活实例会撞端口，配置也可能被改写）。
  if (await deps.probe(8080, 1_500)) {
    console.error('the manager is running — stop it first (npm run service -- uninstall, or Ctrl+C) and then update.')
    process.exit(1)
  }

  const result = await updateManager(deps, root)
  console.log(result.detail)
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
}
