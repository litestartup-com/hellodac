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

test('蜂群2计划 P4: collectNodeHomes 收集三种形态（process 目录 / docker 卷 / 额外卷）', () => {
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

test('蜂群2计划 P4: 节点 home 打包→灾难→恢复 全链路（排除 node_modules 与 pidfile）', async () => {
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
    assert.equal(existsSync(join(home, 'profiles', 'web', 'node_modules', 'junk.js')), false, 'node_modules 被排除')
    assert.equal(existsSync(join(home, 'x.pid')), false, 'pidfile 被排除')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('蜂群2计划 P4: 6 小时内已有归档则跳过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-skip-'))
  const backupDir = join(root, 'backups')
  const home = join(root, 'home')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'a.txt'), 'a', 'utf8')
    const entry: NodeHomeEntry = { nodeId: 'personal', kind: 'dir', home }
    const now = Date.now()
    assert.equal((await packNodeHomes([entry], backupDir, SECRET, undefined, now)).length, 1)
    assert.equal((await packNodeHomes([entry], backupDir, SECRET, undefined, now + 60_000)).length, 0, '6 小时内跳过')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('蜂群2计划 P4: 保留策略 24h 全留 → 每节点每日一份 → 更早按周', () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-prune-'))
  try {
    // 固定「现在」= 2026-01-10 12:00，避免测试跨午夜抖动
    const now = new Date(2026, 0, 10, 12, 0, 0).getTime()
    const make = (file: string, ageMs: number): void => {
      const path = join(root, file)
      writeFileSync(path, 'x', 'utf8')
      utimesSync(path, new Date(now - ageMs), new Date(now - ageMs))
    }
    make('node-personal-20260110-110000.tar.gz.enc', 60 * 60_000) // 1h 前：全留
    make('node-personal-20260109-090000.tar.gz.enc', 27 * 60 * 60_000) // 前一日第一份：留
    make('node-personal-20260109-110000.tar.gz.enc', 25 * 60 * 60_000) // 前一日第二份：删
    make('node-personal-20251201-120000.tar.gz.enc', 40 * 24 * 60 * 60_000) // 更早，当周第一份：留

    const removed = pruneNodeHomeArchives(root, now)
    assert.deepEqual(removed, ['node-personal-20260109-110000.tar.gz.enc'], '同日重复只留最早一份')
    for (const file of ['node-personal-20260110-110000.tar.gz.enc', 'node-personal-20260109-090000.tar.gz.enc', 'node-personal-20251201-120000.tar.gz.enc']) {
      assert.ok(existsSync(join(root, file)), `${file} 应保留`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('债务 R10 回归: docker 卷形态打包/恢复经 runToolIo 流式传输（只绑卷，不 bind 备份目录）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nodebackup-docker-'))
  const backupDir = join(root, 'backups')
  const volumeDir = join(root, 'vol')
  try {
    mkdirSync(join(volumeDir, 'sessions'), { recursive: true })
    writeFileSync(join(volumeDir, 'sessions', 's.json'), '{"v":1}', 'utf8')

    const calls: Array<{ image: string; cmd: string[]; binds: Array<{ from: string; to: string }>; io: { stdin?: string; stdout?: string } }> = []
    // 桩：用本机 tar 模拟工具容器——stdout 写 io.stdout / stdin 读 io.stdin（与 runToolIo 契约一致）
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

    assert.equal(calls[0]?.cmd.slice(0, 3).join(' '), 'tar czf -', '打包必须打到 stdout 流（-），而不是容器内备份路径')
    assert.deepEqual(calls[0]?.binds, [{ from: 'dac-personal', to: '/data' }], '只绑命名卷——备份目录不做宿主路径 bind（ENOENT 根因）')
    assert.ok(calls[0]?.io.stdout !== undefined && calls[0].io.stdout !== '', 'stdout 必须落到 manager 侧的临时文件')

    // 卷内容被改 → restore 流回卷 → 内容还原
    writeFileSync(join(volumeDir, 'sessions', 's.json'), 'changed', 'utf8')
    await restoreNodeHome(entry, archive, backupDir, SECRET, stubRunner)
    assert.equal(readFileSync(join(volumeDir, 'sessions', 's.json'), 'utf8'), '{"v":1}', 'restore 必须经 stdin 流解回卷')
    assert.equal(calls[1]?.cmd[1], 'xzf', '恢复走解包命令')
    assert.ok(calls[1]?.io.stdin !== undefined && calls[1].io.stdin !== '', 'stdin 必须指向 manager 侧解密的临时 tar.gz')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('蜂群2计划 P4: 密钥错误时解密抛错（备份不可解 = 诚实失败）', async () => {
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

test('P6 评审 B4: 恢复目标守卫——非绝对/根/家目录/备份目录内一律拒绝', async () => {
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
        `应拒绝 ${c.home}`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
