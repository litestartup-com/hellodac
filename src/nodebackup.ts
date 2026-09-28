/**
 * Hive plan 2 P4: backup and restore of a node home (chats/settings/skills).
 *
 * Shapes:
 * - bare metal (process runner) -> tar.gz the node directory DSH_HOME (node_modules/pidfile excluded);
 * - container (docker runner) -> tar.gz the named volume through a one-shot alpine tool container;
 * - no-spawn cases such as the brain volume of the compose spine -> declared in `backup.docker_volumes`.
 *
 * Archives are always written encrypted (AES-256-GCM; Debt A1: the key is `BACKUP_KEY` or derived from
 * SESSION_SECRET via HKDF, and old CBC archives stay readable), with the same retention policy as
 * DB snapshots (keep everything for 24h -> one per day for 30 days -> one per week for 12 weeks); a node that
 * already has an archive from the last 6 hours is skipped (chat data is heavy, so 15-minute full packaging is not worth it).
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
  /** dir = an absolute directory; docker = a named volume name. */
  home: string
}

/** Collect node homes from the config (a pure function, unit-testable). */
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
  // Hive plan 2 P4: extra docker volumes (the brain volume of the compose spine and friends)
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

/** The newest archive for a node (null when there is none). */
export const lastNodeHomeArchive = (dir: string, nodeId: string): { file: string; at: number } | null => {
  if (!existsSync(dir)) return null
  const prefix = `node-${nodeId}-`
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.tar.gz.enc'))
    .map((file) => ({ file, at: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return files[0] ?? null
}

/** Retention policy: keep everything for 24h -> one per node per day for 30 days -> one per node per week for 12 weeks. Returns the deleted files. */
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
 * Pack one node home into an encrypted archive. Returns the archive file name; skip/failure semantics are the caller's job.
 * A docker volume goes through a one-shot alpine tool container (a missing image is pulled automatically).
 * `sessionSecret` is handed to the crypt layer, which derives per format (v2 = HKDF/`BACKUP_KEY`; v1 read-compatibility = legacy).
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
      // Debt R10: tar writes to stdout (-) and the manager receives it over the attach stream to write the tarball --
      // only the named volume is bound; the backup directory inside the manager container is not bound as a host path (the ENOENT root cause).
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

/** Pack every node home (nodes with an archive from the last 6 hours are skipped). Returns the archive names packed. */
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
 * Pre-restore guard (review B4): a directory-shaped restore rm -rf's the target -- a path coming from the
 * config may be misconfigured as the root directory, the home directory or the backup directory itself and
 * destroy unrecoverable data. Any target judged "dangerous" is refused outright: better a failed restore than a wiped disk.
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
 * Restore one node home: decrypt the archive -> untar into the target directory (an existing directory is wiped and rebuilt).
 * The docker volume shape untars into the volume through a one-shot tool container.
 */
export const restoreNodeHome = async (
  entry: NodeHomeEntry,
  archiveFile: string,
  backupDir: string,
  sessionSecret: string,
  dockerRunner: DockerRunner | undefined,
): Promise<void> => {
  // Review B4: guard first, cut later -- a dangerous target path is refused before anything is decrypted or deleted
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
      // Debt R10: the tarball is fed to tar inside the container over stdin (the reverse stream; again the backup directory is not bound).
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
