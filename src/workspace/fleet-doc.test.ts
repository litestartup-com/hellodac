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
      brain: { id: 'brain', name: 'The brain', endpoint: 'brain', workspacePath: join(root, 'brain'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null },
      personal: { id: 'personal', name: 'Personal', endpoint: 'personal', workspacePath: join(root, 'personal'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null },
    },
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
}

test('Hive plan 2 P6: fleet.md is derived from the config -- node list / shape / boundaries / environment variable references', () => {
  const config = configFor()
  const doc = renderFleetDoc(config)
  assert.match(doc, /Fleet topology and boundaries/)
  assert.match(doc, /\*\*brain\*\* \(The brain\): external · external · private/)
  assert.match(doc, /\*\*personal\*\* \(Personal\): container · managed · private/)
  assert.match(doc, /\$MANAGER_URL/)
  assert.match(doc, /BRAIN_TOKEN/)
  assert.match(doc, /every cross-node action goes through a manager dispatch/)
  // No real address is hardcoded
  assert.doesNotMatch(doc, /127\.0\.0\.1|172\.\d+/)
})

test('Hive plan 2 P6: the brain token goes into the node user HOME (not into the workspace or git), is idempotent, and is skipped when unset', () => {
  const saved = process.env.BRAIN_TOKEN
  const home = mkdtempSync(join(tmpdir(), 'brain-token-'))
  try {
    process.env.BRAIN_TOKEN = 'test-brain-token-123'
    assert.equal(provisionBrainToken(home), true)
    assert.equal(readFileSync(join(home, BRAIN_TOKEN_FILE), 'utf8'), 'test-brain-token-123')

    // Idempotent: identical content neither errors nor rewrites
    assert.equal(provisionBrainToken(home), true)

    // token unset -> skip, and do not write an empty file
    delete process.env.BRAIN_TOKEN
    const empty = mkdtempSync(join(tmpdir(), 'brain-token-empty-'))
    assert.equal(provisionBrainToken(empty), false)
    assert.equal(existsSync(join(empty, BRAIN_TOKEN_FILE)), false)
  } finally {
    if (saved === undefined) delete process.env.BRAIN_TOKEN
    else process.env.BRAIN_TOKEN = saved
  }
})

test('Hive plan 2 P6: syncFleetDocs writes into every workspace, is idempotent, and updates when the content changes', async () => {
  const config = configFor()
  const updated = await syncFleetDocs(config)
  assert.deepEqual(updated.sort(), ['brain', 'personal'])
  for (const agent of Object.values(config.agents)) {
    assert.equal(readFileSync(join(agent.workspacePath, FLEET_FILE), 'utf8'), renderFleetDoc(config))
    assert.ok(existsSync(join(agent.workspacePath, FLEET_FILE)))
  }
  // Idempotent: identical content is not rewritten
  assert.deepEqual(await syncFleetDocs(config), [])
  // A topology change -> updated automatically
  config.agents['product'] = { id: 'product', name: 'Product', endpoint: 'personal', workspacePath: join(config.agents['brain']!.workspacePath, '..', 'product'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null }
  assert.deepEqual((await syncFleetDocs(config)).sort(), ['brain', 'personal', 'product'])
  assert.match(readFileSync(join(config.agents['product'].workspacePath, FLEET_FILE), 'utf8'), /product/)
})

test('Debt H3 regression: the manager commits fleet.md only -- other files the user has staged never enter its commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-commit-'))
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root, stdio: 'ignore' })
  // The user's own change is already staged -- the manager's commit must not sweep it in
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
  assert.ok(committed.includes('fleet.md'), 'fleet.md should be committed')
  assert.ok(!committed.includes('user-file.txt'), 'a file the user staged must not be swept into the commit')
})
