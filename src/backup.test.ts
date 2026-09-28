import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { backupNow, listSnapshots, pruneSnapshots, restoreSnapshot, snapshotDb } from './backup.js'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'backup-'))
const SECRET = 'backup-test-secret-0123456789'

/** On Windows a handle to a freshly written/overwritten file can be released late (EBUSY): retry the cleanup a few times and give up without failing the test. */
const cleanup = async (dir: string): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 120))
    }
  }
}

test('Hive P6: snapshotDb takes a consistent copy with the same rows', async () => {
  const dir = fresh()
  try {
    const dbPath = join(dir, 'manager.db')
    const src = new Database(dbPath)
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const insert = src.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 50; i += 1) insert.run(`row-${i}`)
    src.close()

    const snap = await snapshotDb(dbPath, join(dir, 'backups'))
    assert.ok(existsSync(join(dir, 'backups', snap.file)))

    const copy = new Database(join(dir, 'backups', snap.file), { readonly: true })
    const rows = copy.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }
    assert.equal(rows.n, 50)
    copy.close()
  } finally {
    await cleanup(dir)
  }
})

test('Hive P6: retention keeps 24h hourly, then daily for 30d, then weekly for 12w', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  mkdirSync(backups, { recursive: true })
  try {
    // Anchor "now" at local noon: the fixtures use relative ages (25h, 35d), and with a live clock
    // those cross the local-midnight day boundary when the suite runs at 00:00-01:00 -- the "same
    // day" pair lands on two calendar days and the retention assertions stop holding. A fixed noon
    // keeps the calendar-day grouping deterministic.
    const anchor = new Date()
    anchor.setHours(12, 0, 0, 0)
    const now = anchor.getTime()
    const MIN = 60_000
    const HOUR = 60 * MIN
    const DAY = 24 * HOUR
    // Returns file names so the assertions can use exact names instead of luck.
    const plant = (age: number): string => {
      const d = new Date(now - age)
      const pad = (n: number): string => String(n).padStart(2, '0')
      const file = `manager-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`
      writeFileSync(join(backups, file), 'x')
      utimesSync(join(backups, file), new Date(now - age), new Date(now - age))
      return file
    }

    // Plant deterministic files in each of the three tiers:
    // 1) three within 24h -- all kept
    const r1 = plant(5 * MIN)
    const r2 = plant(10 * MIN)
    const r3 = plant(15 * MIN)
    // 2) two on the same day beyond 24h -- keep only the first (the earlier one)
    const d1 = plant(25 * HOUR)
    const d2 = plant(25 * HOUR + MIN)
    // 3) two on the same day beyond 30 days (35 days ago) -- the weekly bucket keeps the first
    const w1 = plant(35 * DAY)
    const w2 = plant(35 * DAY + MIN)
    // 4) one 15 weeks ago -- deleted
    const old = plant(100 * DAY)

    const removed = pruneSnapshots(backups, now)
    const kept = listSnapshots(backups).map((s) => s.file)

    for (const f of [r1, r2, r3]) assert.ok(kept.includes(f), `${f} within 24h must be kept`)
    assert.ok(!removed.includes(r1) && !removed.includes(r2) && !removed.includes(r3), 'nothing within 24h is deleted')
    // Retention walks time in order and takes the first of each day = the earlier one
    assert.ok(kept.includes(d2), 'the earlier one of the day is kept')
    assert.ok(!kept.includes(d1), 'the later one of the day is deleted')
    assert.ok(kept.includes(w2), 'the earlier of the two 35 days ago is kept')
    assert.ok(!kept.includes(w1), 'the later one of that day 35 days ago is deleted')
    assert.ok(!kept.includes(old), 'the one 15 weeks ago is deleted')
    assert.equal(kept.length, 5, `3+1+1=5, got ${kept.join(', ')}`)
  } finally {
    await cleanup(dir)
  }
})

test('Debt R2: backupNow artifacts must hold no plaintext (DB snapshot and .env encrypted; no plaintext left in the backup dir)', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  try {
    const dbPath = join(dir, 'manager.db')
    const src = new Database(dbPath)
    src.exec('CREATE TABLE t (v TEXT)')
    src.prepare('INSERT INTO t (v) VALUES (?)').run('sentinel')
    src.close()
    const envPath = join(dir, '.env')
    writeFileSync(envPath, 'SESSION_SECRET=super-secret-value-0123456789abcdef\n', 'utf8')

    const result = await backupNow(dbPath, join(dir, 'cfg.yaml'), envPath, backups, SECRET)

    // The snapshot must be encrypted, with no plaintext snapshot left in the backup directory
    assert.ok(result.snapshot.file.endsWith('.enc'), `the snapshot must be encrypted, got ${result.snapshot.file}`)
    assert.ok(
      listSnapshots(backups).every((s) => s.file.endsWith('.enc')),
      'no plaintext DB snapshot may appear in the backup directory',
    )
    const enc = readFileSync(join(backups, result.snapshot.file))
    assert.ok(!enc.subarray(0, 16).toString('latin1').includes('SQLite'), 'an encrypted snapshot must not carry the plaintext SQLite header')
    // .env is a secret: it lands encrypted, with no plaintext copy
    assert.ok(existsSync(join(backups, 'current', '.env.enc')), '.env must land encrypted')
    assert.ok(!existsSync(join(backups, 'current', '.env')), 'no plaintext .env copy may be kept')
    const envEnc = readFileSync(join(backups, 'current', '.env.enc'), 'utf8')
    assert.ok(!envEnc.includes('super-secret-value'), 'the ciphertext must not contain the plaintext secret')
  } finally {
    await cleanup(dir)
  }
})

test('Hive P6: restoreSnapshot refuses while the manager runs and recovers by name or latest', async () => {  const dir = fresh()
  const backups = join(dir, 'backups')
  try {
    const dbPath = join(dir, 'manager.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (v TEXT)')
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('sentinel')
    seed.close()
    const result = await backupNow(dbPath, join(dir, 'cfg.yaml'), join(dir, '.env'), backups, SECRET)

    // Refused while it runs
    const refused = await restoreSnapshot(dbPath, backups, 'latest', () => true, SECRET)
    assert.equal(refused.ok, false)
    assert.match(refused.detail, /still running/)

    const readSentinel = (): string => {
      const db = new Database(dbPath, { readonly: true })
      const row = db.prepare('SELECT v FROM t LIMIT 1').get() as { v: string }
      db.close()
      return row.v
    }

    // Restore by name (an encrypted snapshot, so it goes through decryption)
    rmSync(dbPath, { force: true })
    const byName = await restoreSnapshot(dbPath, backups, result.snapshot.file, () => false, SECRET)
    assert.equal(byName.ok, true)
    assert.equal(readSentinel(), 'sentinel')

    // latest
    rmSync(dbPath, { force: true })
    const byLatest = await restoreSnapshot(dbPath, backups, 'latest', () => false, SECRET)
    assert.equal(byLatest.ok, true)
    assert.equal(readSentinel(), 'sentinel')

    // Unknown snapshot
    const missing = await restoreSnapshot(dbPath, backups, 'nope.db', () => false, SECRET)
    assert.equal(missing.ok, false)
  } finally {
    await cleanup(dir)
  }
})

test('Debt R2: a tampered encrypted snapshot fails restoration loudly (GCM auth, never swallow corruption)', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  try {
    const dbPath = join(dir, 'manager.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (v TEXT)')
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('sentinel')
    seed.close()
    const result = await backupNow(dbPath, join(dir, 'cfg.yaml'), join(dir, '.env'), backups, SECRET)

    // Flip one byte of the ciphertext (past the magic header, in the region after the IV)
    const encPath = join(backups, result.snapshot.file)
    const buf = Buffer.from(readFileSync(encPath))
    buf[buf.length - 30] = buf[buf.length - 30] === 0x00 ? 0x01 : 0x00
    writeFileSync(encPath, buf)

    rmSync(dbPath, { force: true })
    await assert.rejects(() => restoreSnapshot(dbPath, backups, 'latest', () => false, SECRET), 'tampering must fail loudly')
    assert.ok(!existsSync(dbPath), 'a failed decryption must not leave a DB file that counts as a restore')
  } finally {
    await cleanup(dir)
  }
})

test('Debt R2: a plaintext snapshot from before the upgrade still restores (the compatibility chain holds)', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  try {
    const dbPath = join(dir, 'manager.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (v TEXT)')
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('legacy')
    seed.close()
    // An old-version artifact: a plaintext snapshot sitting straight in the backup directory
    const plain = await snapshotDb(dbPath, backups)
    assert.ok(plain.file.endsWith('.db') && !plain.file.endsWith('.enc'))

    rmSync(dbPath, { force: true })
    const restored = await restoreSnapshot(dbPath, backups, 'latest', () => false, SECRET)
    assert.equal(restored.ok, true)
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare('SELECT v FROM t LIMIT 1').get() as { v: string }
    db.close()
    assert.equal(row.v, 'legacy')
  } finally {
    await cleanup(dir)
  }
})
