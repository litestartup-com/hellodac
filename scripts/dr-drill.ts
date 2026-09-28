/**
 * Hive plan 2 P4: DR drill -- backup → delete the data and the node home → restore → assert it is usable.
 *
 * Everything happens in a temporary directory and never touches real data; one run takes a few seconds. CI runs it
 * every time (npm run drill); the release gate demands that "a backup only counts once a restore has passed".
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupNow, restoreSnapshot } from '../src/backup.js'
import { openDb } from '../src/db/index.js'
import { packNodeHomes, restoreNodeHome, type NodeHomeEntry } from '../src/nodebackup.js'

const SECRET = 'drill-secret-0123456789abcdef0123456789abcdef'
const fail = (message: string): never => {
  console.error(`DR drill failed: ${message}`)
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'dac-drill-'))
const dataDir = join(root, 'data')
const backupDir = join(dataDir, 'backups')
const dbPath = join(dataDir, 'manager.db')
const configPath = join(root, 'manager.config.yaml')
const envPath = join(root, '.env')
const nodeHome = join(root, 'node-home')

console.log(`DR drill directory: ${root}`)

try {
  // ---- 1. Build data: one user row in the DB + a node home (sentinel file + junk that must be excluded) ----
  mkdirSync(dataDir, { recursive: true })
  const { sqlite } = openDb(dbPath)
  sqlite.prepare("INSERT INTO user (username, password_hash, created_at, must_change_password) VALUES ('drill', 'x', 1, 1)").run()
  sqlite.close()

  mkdirSync(join(nodeHome, 'sessions'), { recursive: true })
  mkdirSync(join(nodeHome, 'profiles', 'web', 'node_modules'), { recursive: true })
  writeFileSync(join(nodeHome, 'sessions', 'transcript.json'), '{"keep":"me"}', 'utf8')
  writeFileSync(join(nodeHome, 'profiles', 'web', 'node_modules', 'junk.js'), 'junk', 'utf8')
  writeFileSync(join(nodeHome, 'stale.pid'), '9999', 'utf8')

  writeFileSync(configPath, 'listen:\n  port: 8080\n', 'utf8')
  writeFileSync(envPath, `SESSION_SECRET=${SECRET}\n`, 'utf8')

  // ---- 2. Backup ----
  const startedAt = Date.now()
  const result = await backupNow(dbPath, configPath, envPath, backupDir, SECRET)
  console.log(`backup: ${result.snapshot.file}`)
  const entry: NodeHomeEntry = { nodeId: 'personal', kind: 'dir', home: nodeHome }
  const packed = await packNodeHomes([entry], backupDir, SECRET, undefined)
  if (packed.length !== 1) fail('the node home was not packed')
  console.log(`node home archive: ${packed[0]}`)

  // ---- 3. Disaster: delete the DB and the node home ----
  rmSync(dbPath, { force: true })
  rmSync(nodeHome, { recursive: true, force: true })
  if (existsSync(dbPath) || existsSync(nodeHome)) fail('the deletion was incomplete, the drill environment is not clean')

  // ---- 4. Restore ----
  const restored = await restoreSnapshot(dbPath, backupDir, 'latest', () => false, SECRET)
  if (!restored.ok) fail(restored.detail)
  await restoreNodeHome(entry, packed[0] ?? '', backupDir, SECRET, undefined)

  // ---- 5. Assertions ----
  const { db, sqlite: sqlite2 } = openDb(dbPath)
  const count = sqlite2.prepare('SELECT COUNT(*) AS c FROM user').get() as { c: number }
  void db // the drizzle instance is here only to confirm the query types resolve
  sqlite2.close()
  if (count.c !== 1) fail('the user row count after restore is not 1')

  if (!existsSync(join(nodeHome, 'sessions', 'transcript.json'))) fail('the sentinel file was not restored')
  if (readFileSync(join(nodeHome, 'sessions', 'transcript.json'), 'utf8') !== '{"keep":"me"}') fail('the sentinel content differs')
  if (existsSync(join(nodeHome, 'profiles', 'web', 'node_modules', 'junk.js'))) fail('node_modules should have been excluded but came back')
  if (existsSync(join(nodeHome, 'stale.pid'))) fail('the pidfile should have been excluded but came back')

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`DR drill passed ✅ (backup+disaster+restore, the whole chain, took ${seconds}s, target RTO ≤ 5 minutes)`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
