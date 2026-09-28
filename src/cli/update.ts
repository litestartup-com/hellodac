import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { backupNow } from '../backup.js'
import { loadConfig } from '../config.js'

/**
 * Hive P6: `npm run update` -- manager self-update (backup -> pull -> build -> probe, and a failed
 * probe rolls back automatically to the pre-update commit and rebuilds).
 *
 * Preconditions: the manager is stopped (a probe instance starts briefly during the update); the
 * work tree is clean (config and .env are in .gitignore, so it should not be dirty); the git remote
 * is reachable and the current branch tracks it (fast-forward).
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
  // 0. The work tree must be clean -- a hard reset swallows uncommitted changes (config is in
  //    .gitignore and should not show up here; if it does, something is wrong).
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
    // A failed build rolls back too -- a half-new dist must not stay behind.
    deps.git(['reset', '--hard', oldHead], rootDir)
    try {
      build()
    } catch {
      // The rollback build failed too: the code is restored but dist may not match -- report it as is.
    }
    return { ok: false, detail: `the build failed; code rolled back to ${oldHead.slice(0, 8)} (dist may need a manual npm run build). ${(error as Error).message.split('\n')[0]}`, from: oldHead, to: newHead, snapshot }
  }

  // Probe: start an instance briefly; only a port that answers counts.
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
    // As above: the code is restored but dist may not match.
  }
  return { ok: false, detail: `the new version failed its 30-second health probe; rolled back to ${oldHead.slice(0, 8)} and rebuilt.`, from: oldHead, to: newHead, snapshot }
}

/** The real dependencies (for running the CLI directly). */
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
    // Debt R3: the backup path comes from one successful loadConfig only -- a custom database.path or
    // layout no longer backs up the wrong file; an unreadable config fails loudly (it must be healthy first).
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
          // The process may already have exited
        }
      },
    }
  }
  return { git, run, npm, probe, backup, startProbeInstance, log: (line) => console.log(line) }
}

const main = async (): Promise<void> => {
  const root = resolve(here)
  const deps = realDeps(root)

  // No update while the manager runs (the probe instance collides on the port and the config may be rewritten).
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
