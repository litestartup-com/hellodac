import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import net from 'node:net'
import { createInterface } from 'node:readline/promises'
import { backupNow, listSnapshots, restoreSnapshot } from '../backup.js'
import { loadConfig, type AppConfig } from '../config.js'
import { collectNodeHomes, lastNodeHomeArchive, packNodeHomes, restoreNodeHome } from '../nodebackup.js'
import { DockerRunner } from '../nodes/docker-runner.js'

/**
 * `npm run backup` / `npm run restore -- [snapshot name|latest]` / `npm run backup -- list`
 *
 * Hive P6 + Hive plan 2 P4: a database snapshot (encrypted) + a config copy (plaintext, for human reference only)
 * + the node homes (an encrypted archive). A restore requires the manager to be stopped (liveness is probed on the configured port).
 *
 * Debt R3 (2026-09-12): the database path, the backup directory, the probe port and the secret all come from one
 * successful loadConfig() -- a custom database.path / listen.port no longer backs up or restores the wrong file.
 * A restore refuses loudly when the config is unreadable and never silently falls back to the default database; backup
 * keeps the tolerance A5 established (warn on a broken config + fall back to the cwd-relative default, so the backup itself is not blocked).
 *
 * Debt R4 (2026-09-12) position: `backups/current/manager.config.yaml` and `.env.enc` are only "reference copies inside
 * the same backup directory", and restore puts back the database and the node homes alone -- restoring the config is a
 * human action (rewrite the truth source against the reference copies), and this CLI does no automatic config restore.
 */

/** Port probe: reachable = the manager is running (it must be stopped before a restore). The port comes from loadConfig, no longer hardcoded to 8080. */
const probePort = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const socket = new net.Socket()
    let open = false
    socket.setTimeout(500)
    socket.once('connect', () => {
      open = true
      socket.destroy()
    })
    socket.once('error', () => socket.destroy())
    socket.once('timeout', () => socket.destroy())
    socket.once('close', () => done(open))
    socket.connect(port, '127.0.0.1')
  })

/** Collect the node homes and, when needed, a docker runner while the config is readable (passed the already loaded config, so loadConfig is not called twice). */
const nodeContext = (config: AppConfig | null): { entries: ReturnType<typeof collectNodeHomes>; runner: DockerRunner | undefined } => {
  if (config === null) return { entries: [], runner: undefined }
  const entries = collectNodeHomes(config)
  const runner = entries.some((e) => e.kind === 'docker') ? new DockerRunner({}) : undefined
  return { entries, runner }
}

const main = async (): Promise<void> => {
  const [command, name] = process.argv.slice(2)

  if (command === 'restore') {
    // Debt R3: a restore requires one successful loadConfig -- an unreadable config is refused outright, never a
    // silent fall back to the default database (restoring the wrong file is worse than not restoring).
    let cfg: AppConfig
    try {
      cfg = loadConfig()
    } catch (error) {
      console.error(`config unreadable, refusing to restore: ${(error as Error).message}`)
      process.exit(1)
    }
    const dbPath = cfg.databasePath
    const dir = join(dirname(dbPath), 'backups')
    if (await probePort(cfg.listen.port)) {
      console.error('the manager is still running — stop it before restoring (a restore overwrites the database file).')
      process.exit(1)
    }
    const startedAt = Date.now()
    try {
      const result = await restoreSnapshot(dbPath, dir, name ?? 'latest', () => false, cfg.sessionSecret)
      if (!result.ok) {
        console.log(`restore failed: ${result.detail}`)
        process.exit(1)
      }
      console.log(result.detail)
      // Debt R4 position: the config copies are for human reference only; this CLI does not restore the config automatically.
      console.log('note: the config copies under backups/current/ (manager.config.yaml / .env.enc) are for reference only and were not restored automatically.')
    } catch (error) {
      // A failed decryption of the encrypted snapshot (tampering, or the wrong secret) also lands here -- a loud failure, never silent.
      console.error(`restore failed: ${(error as Error).message}`)
      process.exit(1)
    }

    // Hive plan 2 P4: the node homes are restored along with it (each node takes its newest archive).
    // Review B4: a directory-shaped restore wipes the target -- list the directories that will be wiped and ask for confirmation first.
    const { entries, runner } = nodeContext(cfg)
    const dirTargets = entries.filter((e) => e.kind === 'dir').map((e) => e.home)
    if (dirTargets.length > 0) {
      console.log('these node home directories will be wiped and restored:')
      for (const target of dirTargets) console.log(`  - ${target}`)
      if (process.env.DAC_RESTORE_YES !== '1') {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const answer = await rl.question('Continue? Type yes to proceed, anything else cancels: ')
        rl.close()
        if (answer !== 'yes') {
          console.log('cancelled.')
          process.exit(1)
        }
      }
    }
    for (const entry of entries) {
      const last = lastNodeHomeArchive(dir, entry.nodeId)
      if (last === null) {
        console.warn(`node ${entry.nodeId}: no home archive — skipping.`)
        continue
      }
      try {
        await restoreNodeHome(entry, last.file, dir, cfg.sessionSecret, runner)
        console.log(`node ${entry.nodeId}: home restored from ${last.file}.`)
      } catch (error) {
        console.error(`node ${entry.nodeId}: home restore failed: ${(error as Error).message}`)
        process.exit(1)
      }
    }
    console.log(`restore finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (RTO target ≤ 5 minutes).`)
    return
  }

  // Debt R3: the paths for backup/list come from one successful loadConfig only; on a broken config it warns
  // loudly and falls back to the cwd-relative default (the design A5 settled on -- data protection does not stall because the config is broken).
  let dbPath = resolve('data/manager.db')
  let dir = join(resolve('data'), 'backups')
  let cfg: AppConfig | null = null
  try {
    cfg = loadConfig()
    dbPath = cfg.databasePath
    dir = join(dirname(dbPath), 'backups')
  } catch (error) {
    console.warn(`config unreadable (${(error as Error).message}); falling back to default paths — if you use a custom database.path, fix the config first.`)
  }

  if (command === 'list') {
    const snaps = listSnapshots(dir)
    if (snaps.length === 0) console.log('no snapshots yet.')
    for (const s of snaps) {
      console.log(`${s.file}  ${new Date(s.at).toLocaleString('zh-CN')}  ${(s.bytes / 1024).toFixed(0)} KB`)
    }
    const { entries } = nodeContext(cfg)
    for (const entry of entries) {
      const last = lastNodeHomeArchive(dir, entry.nodeId)
      console.log(last === null ? `node ${entry.nodeId}: no home archive yet` : `node ${entry.nodeId}: ${last.file}  ${new Date(last.at).toLocaleString('en-US')}`)
    }
    return
  }

  // Default = backup
  if (!existsSync(dbPath)) {
    console.error(`no ${dbPath} — start the manager once before backing anything up.`)
    process.exit(1)
  }
  // Debt A5/R3: the truth-source paths come from that same loadConfig result (a single source).
  const configPath = cfg?.configPath ?? resolve('manager.config.yaml')
  const envPath = cfg?.envPath ?? resolve('.env')
  const result = await backupNow(dbPath, configPath, envPath, dir, cfg?.sessionSecret ?? '')
  console.log(`snapshot complete: ${result.snapshot.file} (${(result.snapshot.bytes / 1024).toFixed(0)} KB, encrypted); config copies refreshed.`)
  if (result.pruned.length > 0) console.log(`pruned ${result.pruned.length} old snapshots by the retention policy.`)

  const { entries, runner } = nodeContext(cfg)
  if (cfg !== null && entries.length > 0) {
    const packed = await packNodeHomes(entries, dir, cfg.sessionSecret, runner)
    if (packed.length === 0) console.log('node homes: archived within the last 6 hours — skipping.')
    else console.log(`node home archives (encrypted): ${packed.join(', ')}`)
  } else if (cfg === null) {
    console.warn('node home backup skipped (the config is unreadable).')
  }
}

void main()
