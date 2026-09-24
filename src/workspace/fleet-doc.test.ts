import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderFleetDoc, syncFleetDocs, FLEET_FILE, provisionBrainToken, BRAIN_TOKEN_FILE } from './fleet-doc.js'
import { DEFAULT_PRICING } from '../pricing.js'
import type { AppConfig } from '../config.js'

const configFor = (): AppConfig => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-doc-'))
  return {
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: {
      brain: { id: 'brain', url: 'http://node-brain:3082', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null, access: null },
      personal: {
        id: 'personal',
        url: 'http://node-personal:3081',
        driver: 'apiproxy',
        prefix: '/api',
        key: '',
        sandboxBase: null,
        sandboxKey: '',
        spawn: {
          managed: true,
          command: '',
          args: [],
          cwd: null,
          readyTimeoutMs: 30_000,
          detached: false,
          logFile: null,
          env: {},
          restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
          runner: 'docker',
          host: null,
          docker: { image: 'x', containerName: null, network: 'dac-hive', port: 3081, hostVolumes: {}, namedVolumes: { 'dac-personal': '/data' } },
        },
        access: null,
      },
    },
    agents: {
      brain: { id: 'brain', name: '主脑', endpoint: 'brain', workspacePath: join(root, 'brain'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null },
      personal: { id: 'personal', name: '个人', endpoint: 'personal', workspacePath: join(root, 'personal'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null },
    },
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
}

test('蜂群2计划 P6: fleet.md 派生自配置——节点清单/形态/边界/环境变量引用', () => {
  const config = configFor()
  const doc = renderFleetDoc(config)
  assert.match(doc, /Fleet topology and boundaries/)
  assert.match(doc, /\*\*brain\*\* \(主脑\): external · external · private/)
  assert.match(doc, /\*\*personal\*\* \(个人\): container · managed · private/)
  assert.match(doc, /\$MANAGER_URL/)
  assert.match(doc, /BRAIN_TOKEN/)
  assert.match(doc, /every cross-node action goes through a manager dispatch/)
  // 不写死任何真实地址
  assert.doesNotMatch(doc, /127\.0\.0\.1|172\.\d+/)
})

test('蜂群2计划 P6: 主脑令牌写入节点用户 HOME（不进工作区/git），幂等，未设置则跳过', () => {
  const saved = process.env.BRAIN_TOKEN
  const home = mkdtempSync(join(tmpdir(), 'brain-token-'))
  try {
    process.env.BRAIN_TOKEN = 'test-brain-token-123'
    assert.equal(provisionBrainToken(home), true)
    assert.equal(readFileSync(join(home, BRAIN_TOKEN_FILE), 'utf8'), 'test-brain-token-123')

    // 幂等：内容一致不报错不重写
    assert.equal(provisionBrainToken(home), true)

    // token 未设置 → 跳过，不写空文件
    delete process.env.BRAIN_TOKEN
    const empty = mkdtempSync(join(tmpdir(), 'brain-token-empty-'))
    assert.equal(provisionBrainToken(empty), false)
    assert.equal(existsSync(join(empty, BRAIN_TOKEN_FILE)), false)
  } finally {
    if (saved === undefined) delete process.env.BRAIN_TOKEN
    else process.env.BRAIN_TOKEN = saved
  }
})

test('蜂群2计划 P6: syncFleetDocs 写入每个工作区、幂等、内容变化时更新', async () => {
  const config = configFor()
  const updated = await syncFleetDocs(config)
  assert.deepEqual(updated.sort(), ['brain', 'personal'])
  for (const agent of Object.values(config.agents)) {
    assert.equal(readFileSync(join(agent.workspacePath, FLEET_FILE), 'utf8'), renderFleetDoc(config))
    assert.ok(existsSync(join(agent.workspacePath, FLEET_FILE)))
  }
  // 幂等：内容一致不重写
  assert.deepEqual(await syncFleetDocs(config), [])
  // 拓扑变化 → 自动更新
  config.agents['product'] = { id: 'product', name: '产品', endpoint: 'personal', workspacePath: join(config.agents['brain']!.workspacePath, '..', 'product'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null }
  assert.deepEqual((await syncFleetDocs(config)).sort(), ['brain', 'personal', 'product'])
  assert.match(readFileSync(join(config.agents['product'].workspacePath, FLEET_FILE), 'utf8'), /product/)
})

test('债务 H3 回归: manager 只提交 fleet.md——用户已 staged 的其他文件绝不进它的提交', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-commit-'))
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root, stdio: 'ignore' })
  // 用户自己的改动已暂存——manager 的提交不得捎带
  writeFileSync(join(root, 'user-file.txt'), 'user data', 'utf8')
  execFileSync('git', ['add', '--', 'user-file.txt'], { cwd: root, stdio: 'ignore' })

  const config = configFor()
  config.agents['brain']!.workspacePath = root
  delete config.agents['personal']
  await syncFleetDocs(config)

  const subject = execFileSync('git', ['log', '--format=%s', '-1'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(subject, 'chore: update fleet.md (generated by the manager)')
  const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .filter((f) => f !== '')
  assert.ok(committed.includes('fleet.md'), 'fleet.md 应被提交')
  assert.ok(!committed.includes('user-file.txt'), '用户 staged 的文件不得被捎带提交')
})
