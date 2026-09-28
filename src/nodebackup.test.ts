import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectNodeHomes, packNodeHomes, pruneNodeHomeArchives, restoreNodeHome, type NodeHomeEntry } from './nodebackup.js'
import { decryptFile, encryptFile } from './crypt.js'
import type { DockerRunner } from './nodes/docker-runner.js'
import type { AppConfig } from './config.js'

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'

test('Hive plan 2 P4: collectNodeHomes gathers all three forms (process directory / docker volume / extra volume)', () => {
  const config = {
    endpoints: {
      personal: { spawn: { runner: 'process', env: { DSH_HOME: '/homes/personal' } } },
      product: { spawn: { runner: 'docker', docker: { namedVolumes: { 'dac-product': '/data' } } } },
      brain: { spawn: null },
    },
    backupDockerVolumes: ['dac-brain'],
  } as unknown as AppConfig
  assert.deepEqual(collectNodeHomes(config), [
    { nodeId: 'personal', kind: 'dir', home: '/homes/personal' },
    { nodeId: 'product', kind: 'docker', home: 'dac-product' },
    { nodeId: 'dac-brain', kind: 'docker', home: 'dac-brain' },
  ])
})

test('Hive plan 2 P4: the full round trip for a node home -- pack -> disaster -> restore (node_modules and pidfile excluded)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-'))
  const backupDir = join(root, 'backups')
  const home = join(root, 'home')
  try {
    mkdirSync(join(home, 'sessions'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'web', 'node_modules'), { recursive: true })
    writeFileSync(join(home, 'sessions', 't.json'), '{"ok":1}', 'utf8')
    writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'junk.js'), 'junk', 'utf8')
    writeFileSync(join(home, 'x.pid'), '1', 'utf8')

    const entry: NodeHomeEntry = { nodeId: 'personal', kind: 'dir', home }
    const packed = await packNodeHomes([entry], backupDir, SECRET, undefined)
    assert.equal(packed.length, 1)
    const archive = packed[0] ?? ''

    rmSync(home, { recursive: true, force: true })
    await restoreNodeHome(entry, archive, backupDir, SECRET, undefined)

    assert.equal(readFileSync(join(home, 'sessions', 't.json'), 'utf8'), '{"ok":1}')
    assert.equal(existsSync(join(home, 'profiles', 'web', 'node_modules', 'junk.js')), false, 'node_modules is excluded')
    assert.equal(existsSync(join(home, 'x.pid')), false, 'the pidfile is excluded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Hive plan 2 P4: an archive from within the last 6 hours means skip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-skip-'))
  const backupDir = join(root, 'backups')
  const home = join(root, 'home')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'a.txt'), 'a', 'utf8')
    const entry: NodeHomeEntry = { nodeId: 'personal', kind: 'dir', home }
    const now = Date.now()
    assert.equal((await packNodeHomes([entry], backupDir, SECRET, undefined, now)).length, 1)
    assert.equal((await packNodeHomes([entry], backupDir, SECRET, undefined, now + 60_000)).length, 0, 'skipped within 6 hours')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Hive plan 2 P4: retention -- keep everything for 24h -> one per node per day -> weekly for anything older', () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-prune-'))
  try {
    // Pin "now" to 2026-01-10 12:00 so the test cannot wobble across midnight
    const now = new Date(2026, 0, 10, 12, 0, 0).getTime()
    const make = (file: string, ageMs: number): void => {
      const path = join(root, file)
      writeFileSync(path, 'x', 'utf8')
      utimesSync(path, new Date(now - ageMs), new Date(now - ageMs))
    }
    make('node-personal-20260110-110000.tar.gz.enc', 60 * 60_000) // 1h ago: keep everything
    make('node-personal-20260109-090000.tar.gz.enc', 27 * 60 * 60_000) // first of the previous day: keep
    make('node-personal-20260109-110000.tar.gz.enc', 25 * 60 * 60_000) // second of the previous day: delete
    make('node-personal-20251201-120000.tar.gz.enc', 40 * 24 * 60 * 60_000) // older, first of that week: keep

    const removed = pruneNodeHomeArchives(root, now)
    assert.deepEqual(removed, ['node-personal-20260109-110000.tar.gz.enc'], 'duplicates on the same day keep only the earliest')
    for (const file of ['node-personal-20260110-110000.tar.gz.enc', 'node-personal-20260109-090000.tar.gz.enc', 'node-personal-20251201-120000.tar.gz.enc']) {
      assert.ok(existsSync(join(root, file)), `${file} should have been kept`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Debt R10 regression: packing/restoring a docker volume streams through runToolIo (bind the volume only, never the backup directory)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-docker-'))
  const backupDir = join(root, 'backups')
  const volumeDir = join(root, 'vol')
  try {
    mkdirSync(join(volumeDir, 'sessions'), { recursive: true })
    writeFileSync(join(volumeDir, 'sessions', 's.json'), '{"v":1}', 'utf8')

    const calls: Array<{ image: string; cmd: string[]; binds: Array<{ from: string; to: string }>; io: { stdin?: string; stdout?: string } }> = []
    // Stub: the local tar stands in for the tool container -- stdout writes io.stdout and stdin reads io.stdin (matching the runToolIo contract)
    const stubRunner = {
      runToolIo: async (
        image: string,
        cmd: string[],
        binds: Array<{ from: string; to: string }>,
        io: { stdin?: string; stdout?: string },
      ): Promise<void> => {
        calls.push({ image, cmd, binds, io })
        if (cmd[1] === 'czf') {
          execFileSync('tar', ['czf', io.stdout ?? '', '-C', volumeDir, '.'], { stdio: ['ignore', 'ignore', 'pipe'] })
        } else {
          execFileSync('tar', ['xzf', io.stdin ?? '', '-C', volumeDir], { stdio: ['ignore', 'ignore', 'pipe'] })
        }
      },
    } as unknown as DockerRunner

    const entry: NodeHomeEntry = { nodeId: 'personal', kind: 'docker', home: 'dac-personal' }
    const packed = await packNodeHomes([entry], backupDir, SECRET, stubRunner)
    assert.equal(packed.length, 1)
    const archive = packed[0] ?? ''

    assert.equal(calls[0]?.cmd.slice(0, 3).join(' '), 'tar czf -', 'packing must go to the stdout stream (-), not to an in-container backup path')
    assert.deepEqual(calls[0]?.binds, [{ from: 'dac-personal', to: '/data' }], 'bind the named volume only -- the backup directory is never bound as a host path (the ENOENT root cause)')
    assert.ok(calls[0]?.io.stdout !== undefined && calls[0].io.stdout !== '', 'stdout must land in a manager-side temporary file')

    // The volume content is changed -> restore streams it back -> the content is back
    writeFileSync(join(volumeDir, 'sessions', 's.json'), 'changed', 'utf8')
    await restoreNodeHome(entry, archive, backupDir, SECRET, stubRunner)
    assert.equal(readFileSync(join(volumeDir, 'sessions', 's.json'), 'utf8'), '{"v":1}', 'restore must unpack back into the volume through the stdin stream')
    assert.equal(calls[1]?.cmd[1], 'xzf', 'the restore runs the unpack command')
    assert.ok(calls[1]?.io.stdin !== undefined && calls[1].io.stdin !== '', 'stdin must point at the decrypted manager-side temporary tar.gz')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Hive plan 2 P4: a wrong secret makes decryption throw (an unreadable backup = an honest failure)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-key-'))
  try {
    const plain = join(root, 'plain.txt')
    const enc = join(root, 'plain.enc')
    const out = join(root, 'out.txt')
    writeFileSync(plain, 'secret-data', 'utf8')
    await encryptFile(plain, enc, SECRET)
    await assert.rejects(() => decryptFile(enc, out, 'wrong-secret-0123456789abcdef0123456789abcdef'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P6 review B4: the restore target guard -- rejects anything non-absolute, the root, a home directory, or a path inside the backup directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-guard-'))
  const backupDir = join(root, 'backups')
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(join(backupDir, 'dummy.tar.gz.enc'), 'x', 'utf8')
  const cases: Array<{ home: string; match: RegExp }> = [
    { home: 'relative/home', match: /not an absolute path/ },
    { home: process.env.USERPROFILE ?? process.env.HOME ?? '/', match: /the target is the root, cwd or home directory/ },
    { home: backupDir, match: /sits inside the backup directory/ },
  ]
  try {
    for (const c of cases) {
      await assert.rejects(
        () => restoreNodeHome({ nodeId: 'x', kind: 'dir', home: c.home }, 'dummy.tar.gz.enc', backupDir, SECRET, undefined),
        c.match,
        `should have rejected ${c.home}`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
