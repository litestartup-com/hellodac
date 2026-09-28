import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { decryptFile, encryptFile } from './crypt.js'

/**
 * Hive P6: database backup/restore (RPO <= 15 minutes, RTO <= 5 minutes).
 *
 * Snapshots use better-sqlite3's native backup(): consistent under WAL, no downtime.
 * Retention (§3.5): keep everything from the last 24 hours (15-minute granularity) -> then one per
 * day for 30 days -> then one per week for 12 weeks.
 *
 * Debt R2 (backup threat model, 2026-09-12): DB snapshots and .env copies land in the backup
 * directory GCM-encrypted (reusing crypt.ts's v2 format), with plaintext only briefly in the system
 * temp directory. A pre-upgrade plaintext snapshot still restores (the chain holds): restore branches on `.enc`.
 */

export interface SnapshotInfo {
  file: string
  at: number
  bytes: number
}

/** DB snapshots in the backup directory in time order (both plaintext `.db` and encrypted `.db.enc`). */
export const listSnapshots = (dir: string): SnapshotInfo[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^manager-\d{8}-\d{6}\.db(\.enc)?$/.test(f))
    .map((file) => {
      const path = join(dir, file)
      return { file, at: statSync(path).mtimeMs, bytes: statSync(path).size }
    })
    .sort((a, b) => a.at - b.at)
}

/**
 * Take a consistent snapshot of manager.db into the backup directory and return its info.
 * Failures throw: a failed backup must be visible, never swallowed silently.
 */
export const snapshotDb = async (dbPath: string, dir: string, now = Date.now()): Promise<SnapshotInfo> => {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const file = `manager-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.db`
  const out = join(dir, file)
  const src = new Database(dbPath, { readonly: true, fileMustExist: true })
  await src.backup(out) // better-sqlite3: pass the target path, consistent copy (WAL-safe), asynchronous
  src.close()
  return { file, at: now, bytes: statSync(out).size }
}

/** Prune snapshots past the retention policy. Returns the deleted file names. */
export const pruneSnapshots = (dir: string, now = Date.now()): string[] => {
  const all = listSnapshots(dir)
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  const kept = new Set<string>()
  const firstOfDay = new Set<string>()
  const firstOfWeek = new Set<string>()

  for (const s of all) {
    if (now - s.at <= 24 * HOUR) {
      kept.add(s.file)
      continue
    }
    const d = new Date(s.at)
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (!firstOfDay.has(dayKey)) {
      firstOfDay.add(dayKey)
      if (now - s.at <= 30 * DAY) {
        kept.add(s.file)
        continue
      }
      // Weekly bucket: take each Monday (the earliest copy of that Monday)
      const weekKey = weekStamp(d)
      if (!firstOfWeek.has(weekKey) && now - s.at <= 12 * 7 * DAY) {
        firstOfWeek.add(weekKey)
        kept.add(s.file)
      }
    }
  }

  const removed: string[] = []
  for (const s of all) {
    if (!kept.has(s.file)) {
      rmSync(join(dir, s.file), { force: true })
      removed.push(s.file)
    }
  }
  return removed
}

/** Timestamp key of Monday 00:00 (the weekly bucket). */
const weekStamp = (d: Date): string => {
  const day = d.getDay() === 0 ? 7 : d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - (day - 1))
  monday.setHours(0, 0, 0, 0)
  return String(monday.getTime())
}

export interface BackupResult {
  snapshot: SnapshotInfo
  pruned: string[]
}

/**
 * One full backup: DB snapshot (encrypted) + config (a plaintext manager.config.yaml copy, for
 * human reference only) + .env (encrypted copy) + manifest. No plaintext secret lands in the backup dir.
 */
export const backupNow = async (
  dbPath: string,
  configPath: string,
  envPath: string,
  dir: string,
  sessionSecret: string,
): Promise<BackupResult> => {
  // Debt R2: a plaintext snapshot never reaches the backup medium -- it lands in the system temp
  // directory first and enters the backup dir only as <file>.enc; a crash mid-way leaves no plaintext.
  mkdirSync(dir, { recursive: true })
  const tmpDir = mkdtempSync(join(tmpdir(), 'dac-bak-'))
  let snapshot: SnapshotInfo
  try {
    const plain = await snapshotDb(dbPath, tmpDir)
    const out = join(dir, `${plain.file}.enc`)
    await encryptFile(join(tmpDir, plain.file), out, sessionSecret)
    snapshot = { file: `${plain.file}.enc`, at: plain.at, bytes: statSync(out).size }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  const current = join(dir, 'current')
  mkdirSync(current, { recursive: true })
  if (existsSync(configPath)) copyFileSync(configPath, join(current, 'manager.config.yaml'))
  // Debt R2: .env holds SESSION_SECRET/GW key/BRAIN_TOKEN and is a secret -- only a GCM-encrypted
  // copy lands; a plaintext copy left by an older version is removed at once.
  if (existsSync(envPath)) await encryptFile(envPath, join(current, '.env.enc'), sessionSecret)
  rmSync(join(current, '.env'), { force: true })
  // Debt R4: the config copy is for human reference only; restore brings back the DB and node homes (stated in the manifest).
  writeFileSync(
    join(current, 'manifest.json'),
    JSON.stringify({ at: snapshot.at, snapshot: snapshot.file, configReferenceOnly: true, envEncrypted: true }, null, 2),
    'utf8',
  )
  const pruned = pruneSnapshots(dir, snapshot.at)
  return { snapshot, pruned }
}

/** Whether restore is blocked: never overwrite the manager's DB while it runs. probe = the liveness probe. */
export interface RestoreResult {
  ok: boolean
  detail: string
}

export const restoreSnapshot = async (
  dbPath: string,
  dir: string,
  name: string,
  managerRunning: () => boolean,
  sessionSecret: string,
): Promise<RestoreResult> => {
  if (managerRunning()) {
    return { ok: false, detail: 'the manager is still running — stop it before restoring (a restore overwrites the database file).' }
  }
  const snaps = listSnapshots(dir)
  const pick = name === 'latest' ? snaps[snaps.length - 1] : snaps.find((s) => s.file === name)
  if (pick === undefined) {
    return { ok: false, detail: name === 'latest' ? 'no snapshot to restore.' : `snapshot ${name} not found.` }
  }
  if (pick.file.endsWith('.enc')) {
    // Debt R2: an encrypted snapshot (GCM auth) -- tampering or a wrong key throws at decryption,
    // and a damaged DB is never counted as a successful restore.
    await decryptFile(join(dir, pick.file), dbPath, sessionSecret)
  } else {
    // A plaintext snapshot from before the upgrade still restores (the compatibility chain holds).
    // Copy straight over the target: the manager is stopped (the caller checks), so the two-step
    // rename is pointless -- on Windows both rename-over and unlink hit held handles (EBUSY) easily.
    copyFileSync(join(dir, pick.file), dbPath)
  }
  return { ok: true, detail: `restored from ${pick.file} (${new Date(pick.at).toLocaleString('en-US')}).` }
}
