/**
 * 蜂群2计划 P4：DR 演练 —— 备份 → 删除数据与节点 home → 恢复 → 断言可用。
 *
 * 全部在临时目录中进行，绝不碰真实数据；跑一次约几秒。CI 每次跑（npm run drill），
 * 发布门槛要求「恢复过才算备份过」。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupNow, restoreSnapshot } from '../src/backup.js'
import { openDb } from '../src/db/index.js'
import { packNodeHomes, restoreNodeHome, type NodeHomeEntry } from '../src/nodebackup.js'

const SECRET = 'drill-secret-0123456789abcdef0123456789abcdef'
const fail = (message: string): never => {
  console.error(`DR 演练失败：${message}`)
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'dac-drill-'))
const dataDir = join(root, 'data')
const backupDir = join(dataDir, 'backups')
const dbPath = join(dataDir, 'manager.db')
const configPath = join(root, 'manager.config.yaml')
const envPath = join(root, '.env')
const nodeHome = join(root, 'node-home')

console.log(`DR 演练目录：${root}`)

try {
  // ---- 1. 造数据：DB 一行用户 + 节点 home（哨兵文件 + 应被排除的垃圾）----
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

  // ---- 2. 备份 ----
  const startedAt = Date.now()
  const result = await backupNow(dbPath, configPath, envPath, backupDir, SECRET)
  console.log(`备份：${result.snapshot.file}`)
  const entry: NodeHomeEntry = { nodeId: 'personal', kind: 'dir', home: nodeHome }
  const packed = await packNodeHomes([entry], backupDir, SECRET, undefined)
  if (packed.length !== 1) fail('节点 home 未打包')
  console.log(`节点 home 归档：${packed[0]}`)

  // ---- 3. 灾难：删掉 DB 与节点 home ----
  rmSync(dbPath, { force: true })
  rmSync(nodeHome, { recursive: true, force: true })
  if (existsSync(dbPath) || existsSync(nodeHome)) fail('删除不彻底，演练环境不干净')

  // ---- 4. 恢复 ----
  const restored = await restoreSnapshot(dbPath, backupDir, 'latest', () => false, SECRET)
  if (!restored.ok) fail(restored.detail)
  await restoreNodeHome(entry, packed[0] ?? '', backupDir, SECRET, undefined)

  // ---- 5. 断言 ----
  const { db, sqlite: sqlite2 } = openDb(dbPath)
  const count = sqlite2.prepare('SELECT COUNT(*) AS c FROM user').get() as { c: number }
  void db // drizzle 实例仅用于确认可正常查询类型
  sqlite2.close()
  if (count.c !== 1) fail('恢复后用户行数不是 1')

  if (!existsSync(join(nodeHome, 'sessions', 'transcript.json'))) fail('哨兵文件未恢复')
  if (readFileSync(join(nodeHome, 'sessions', 'transcript.json'), 'utf8') !== '{"keep":"me"}') fail('哨兵内容不一致')
  if (existsSync(join(nodeHome, 'profiles', 'web', 'node_modules', 'junk.js'))) fail('node_modules 应被排除却恢复了')
  if (existsSync(join(nodeHome, 'stale.pid'))) fail('pidfile 应被排除却恢复了')

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`DR 演练通过 ✅（备份+灾难+恢复全链路，耗时 ${seconds}s，目标 RTO ≤ 5 分钟）`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
