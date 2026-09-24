import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPendingUpdate, currentAgentVersion } from './agent/update.mjs'

test('能力四 M4-3: applyPendingUpdate——.next 原子换装、版本标记落盘、.prev 保留上一代', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'))
  try {
    writeFileSync(join(dir, 'agent.mjs'), 'old-entry')
    writeFileSync(join(dir, 'runtime.mjs'), 'old-runtime')
    mkdirSync(join(dir, '.next'), { recursive: true })
    writeFileSync(join(dir, '.next', 'agent.mjs'), 'new-entry')
    writeFileSync(join(dir, '.next', 'runtime.mjs'), 'new-runtime')
    writeFileSync(join(dir, '.next', '.version'), '9.9.9')
    applyPendingUpdate(dir)
    assert.equal(readFileSync(join(dir, 'agent.mjs'), 'utf8'), 'new-entry', '新入口生效')
    assert.equal(readFileSync(join(dir, 'runtime.mjs'), 'utf8'), 'new-runtime', '新 runtime 生效')
    assert.equal(readFileSync(join(dir, '.prev', 'agent.mjs'), 'utf8'), 'old-entry', '上一代保留（回滚源）')
    assert.equal(readFileSync(join(dir, '.prev', 'runtime.mjs'), 'utf8'), 'old-runtime')
    assert.equal(currentAgentVersion(dir), '9.9.9', '版本标记落盘')
    assert.ok(!existsSync(join(dir, '.next')), '.next 已消费')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力四 M4-3: 秒崩回滚——90s 内重启 + 换装 10 分钟内 → 恢复上一代', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'))
  try {
    writeFileSync(join(dir, 'agent.mjs'), 'bad-entry')
    writeFileSync(join(dir, 'runtime.mjs'), 'bad-runtime')
    mkdirSync(join(dir, '.prev'), { recursive: true })
    writeFileSync(join(dir, '.prev', 'agent.mjs'), 'good-entry')
    writeFileSync(join(dir, '.prev', 'runtime.mjs'), 'good-runtime')
    writeFileSync(join(dir, '.update-at'), String(Date.now() - 60_000), 'utf8')
    writeFileSync(join(dir, '.update-version'), '9.9.9', 'utf8')
    writeFileSync(join(dir, '.last-boot'), String(Date.now() - 60_000), 'utf8')
    applyPendingUpdate(dir)
    assert.equal(readFileSync(join(dir, 'agent.mjs'), 'utf8'), 'good-entry', '回滚到上一代')
    assert.equal(readFileSync(join(dir, 'runtime.mjs'), 'utf8'), 'good-runtime')
    assert.ok(!existsSync(join(dir, '.update-at')), '回滚后清更新标记')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力四 M4-3: 正常重启不回滚——换装超过 10 分钟 → 新代码保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'))
  try {
    writeFileSync(join(dir, 'agent.mjs'), 'new-entry')
    writeFileSync(join(dir, 'runtime.mjs'), 'new-runtime')
    mkdirSync(join(dir, '.prev'), { recursive: true })
    writeFileSync(join(dir, '.prev', 'agent.mjs'), 'good-entry')
    writeFileSync(join(dir, '.update-at'), String(Date.now() - 11 * 60_000), 'utf8')
    writeFileSync(join(dir, '.last-boot'), String(Date.now() - 60_000), 'utf8')
    applyPendingUpdate(dir)
    assert.equal(readFileSync(join(dir, 'agent.mjs'), 'utf8'), 'new-entry', '超过窗口不误判为秒崩')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
