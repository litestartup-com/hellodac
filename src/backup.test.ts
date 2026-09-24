import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { backupNow, listSnapshots, pruneSnapshots, restoreSnapshot, snapshotDb } from './backup.js'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'backup-'))
const SECRET = 'backup-test-secret-0123456789'

/** Windows 上刚写入/覆盖过的文件句柄可能滞后释放（EBUSY）：清理重试几次，最后放弃也不炸测试。 */
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

test('蜂群 P6: snapshotDb takes a consistent copy with the same rows', async () => {
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

test('蜂群 P6: retention keeps 24h hourly, then daily for 30d, then weekly for 12w', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  mkdirSync(backups, { recursive: true })
  try {
    const now = Date.now()
    const MIN = 60_000
    const HOUR = 60 * MIN
    const DAY = 24 * HOUR
    // 返回文件名，断言用精确名字而不是碰运气。
    const plant = (age: number): string => {
      const d = new Date(now - age)
      const pad = (n: number): string => String(n).padStart(2, '0')
      const file = `manager-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`
      writeFileSync(join(backups, file), 'x')
      utimesSync(join(backups, file), new Date(now - age), new Date(now - age))
      return file
    }

    // 三层各埋确定性的文件：
    // 1) 24h 内 3 份——全留
    const r1 = plant(5 * MIN)
    const r2 = plant(10 * MIN)
    const r3 = plant(15 * MIN)
    // 2) 超过 24h 的同一天 2 份——只留第一份（更早那份）
    const d1 = plant(25 * HOUR)
    const d2 = plant(25 * HOUR + MIN)
    // 3) 超过 30 天的同一天 2 份（35 天）——周桶留第一份
    const w1 = plant(35 * DAY)
    const w2 = plant(35 * DAY + MIN)
    // 4) 15 周前 1 份——删
    const old = plant(100 * DAY)

    const removed = pruneSnapshots(backups, now)
    const kept = listSnapshots(backups).map((s) => s.file)

    for (const f of [r1, r2, r3]) assert.ok(kept.includes(f), `24h 内的 ${f} 必须保留`)
    assert.ok(!removed.includes(r1) && !removed.includes(r2) && !removed.includes(r3), '24h 内不删')
    // 保留策略按时间正序取「每天第一份」= 更早的那份
    assert.ok(kept.includes(d2), '同一天更早那份保留')
    assert.ok(!kept.includes(d1), '同一天更晚那份删除')
    assert.ok(kept.includes(w2), '35 天前周桶更早那份保留')
    assert.ok(!kept.includes(w1), '35 天前同天更晚那份删除')
    assert.ok(!kept.includes(old), '15 周前删除')
    assert.equal(kept.length, 5, `3+1+1=5，实际 ${kept.join(', ')}`)
  } finally {
    await cleanup(dir)
  }
})

test('债务 R2: backupNow 产物必须无明文(DB 快照与 .env 加密;备份目录不留明文)', async () => {
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

    // 快照必须是加密形态,且备份目录里没有任何明文快照残留
    assert.ok(result.snapshot.file.endsWith('.enc'), `快照必须是加密形态,got ${result.snapshot.file}`)
    assert.ok(
      listSnapshots(backups).every((s) => s.file.endsWith('.enc')),
      '备份目录不得出现明文 DB 快照',
    )
    const enc = readFileSync(join(backups, result.snapshot.file))
    assert.ok(!enc.subarray(0, 16).toString('latin1').includes('SQLite'), '加密快照不得含 SQLite 明文头')
    // .env 是秘密:必须加密落盘,无明文副本
    assert.ok(existsSync(join(backups, 'current', '.env.enc')), '.env 必须加密落盘')
    assert.ok(!existsSync(join(backups, 'current', '.env')), '不得保留明文 .env 副本')
    const envEnc = readFileSync(join(backups, 'current', '.env.enc'), 'utf8')
    assert.ok(!envEnc.includes('super-secret-value'), '密文不得含明文密钥')
  } finally {
    await cleanup(dir)
  }
})

test('蜂群 P6: restoreSnapshot refuses while the manager runs and recovers by name or latest', async () => {  const dir = fresh()
  const backups = join(dir, 'backups')
  try {
    const dbPath = join(dir, 'manager.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (v TEXT)')
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('sentinel')
    seed.close()
    const result = await backupNow(dbPath, join(dir, 'cfg.yaml'), join(dir, '.env'), backups, SECRET)

    // 运行中拒绝
    const refused = await restoreSnapshot(dbPath, backups, 'latest', () => true, SECRET)
    assert.equal(refused.ok, false)
    assert.match(refused.detail, /still running/)

    const readSentinel = (): string => {
      const db = new Database(dbPath, { readonly: true })
      const row = db.prepare('SELECT v FROM t LIMIT 1').get() as { v: string }
      db.close()
      return row.v
    }

    // 按名恢复（加密快照，走解密路径）
    rmSync(dbPath, { force: true })
    const byName = await restoreSnapshot(dbPath, backups, result.snapshot.file, () => false, SECRET)
    assert.equal(byName.ok, true)
    assert.equal(readSentinel(), 'sentinel')

    // latest
    rmSync(dbPath, { force: true })
    const byLatest = await restoreSnapshot(dbPath, backups, 'latest', () => false, SECRET)
    assert.equal(byLatest.ok, true)
    assert.equal(readSentinel(), 'sentinel')

    // 未知快照
    const missing = await restoreSnapshot(dbPath, backups, 'nope.db', () => false, SECRET)
    assert.equal(missing.ok, false)
  } finally {
    await cleanup(dir)
  }
})

test('债务 R2: 加密快照被篡改后恢复显性失败(GCM 认证,绝不静默吞损坏)', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  try {
    const dbPath = join(dir, 'manager.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (v TEXT)')
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('sentinel')
    seed.close()
    const result = await backupNow(dbPath, join(dir, 'cfg.yaml'), join(dir, '.env'), backups, SECRET)

    // 篡改密文中的一个字节(跳过 magic 头,打 IV 之后的密文区)
    const encPath = join(backups, result.snapshot.file)
    const buf = Buffer.from(readFileSync(encPath))
    buf[buf.length - 30] = buf[buf.length - 30] === 0x00 ? 0x01 : 0x00
    writeFileSync(encPath, buf)

    rmSync(dbPath, { force: true })
    await assert.rejects(() => restoreSnapshot(dbPath, backups, 'latest', () => false, SECRET), '篡改必须显性失败')
    assert.ok(!existsSync(dbPath), '解密失败不得留下被当成恢复成功的库文件')
  } finally {
    await cleanup(dir)
  }
})

test('债务 R2: 升级前的明文快照仍可恢复(兼容链不打断)', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  try {
    const dbPath = join(dir, 'manager.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (v TEXT)')
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('legacy')
    seed.close()
    // 旧版备份物:明文快照直接落在备份目录
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
