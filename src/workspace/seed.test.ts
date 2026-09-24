import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedEmptyWorkspaces } from './seed.js'

test('蜂群2计划 P6: 空工作区播种模板 + git；非空工作区绝不触碰', () => {
  const root = mkdtempSync(join(tmpdir(), 'seed-'))
  const brain = join(root, 'brain')
  const personal = join(root, 'personal')
  const noteVault = join(root, 'note-vault')
  try {
    mkdirSync(brain, { recursive: true })
    mkdirSync(personal, { recursive: true })
    mkdirSync(noteVault, { recursive: true })
    writeFileSync(join(noteVault, '笔记.md'), '我的笔记', 'utf8')

    const seeded = seedEmptyWorkspaces([
      { id: 'brain', workspacePath: brain },
      { id: 'personal', workspacePath: personal },
      { id: 'note-vault', workspacePath: noteVault },
    ])

    assert.deepEqual(seeded.sort(), ['brain', 'personal'])
    assert.ok(existsSync(join(brain, 'AGENTS.md')), '主脑模板含 AGENTS.md')
    assert.ok(existsSync(join(brain, '.skills', 'brain-api', 'SKILL.md')), '主脑模板含技能手册')
    assert.ok(existsSync(join(brain, '.git')), '播种即建独立 git 仓')
    assert.ok(existsSync(join(personal, 'AGENTS.md')))
    // 非空工作区：文件原样、没被塞模板
    assert.equal(readdirSync(noteVault).length, 1)
    assert.equal(existsSync(join(noteVault, 'AGENTS.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('蜂群2计划 P6: 模板不存在的节点名回退最小 git 初始化', () => {
  const root = mkdtempSync(join(tmpdir(), 'seed-fallback-'))
  const odd = join(root, 'some-random-node')
  try {
    mkdirSync(odd, { recursive: true })
    const seeded = seedEmptyWorkspaces([{ id: 'some-random-node', workspacePath: odd }])
    assert.deepEqual(seeded, ['some-random-node'])
    assert.ok(existsSync(join(odd, 'AGENTS.md')), '通用 AGENTS.md 兜底')
    assert.ok(existsSync(join(odd, '.git')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
