import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mutateYamlFile, withConfigLock, writeFileAtomic } from './config-store.js'

/**
 * Debt A3: atomic writes to the source of truth manager.config.yaml.
 * The old code went read -> parse (JS object) -> stringify -> write: comments lost, truncation on a crash, no post-write check.
 */

const dir = mkdtempSync(join(tmpdir(), 'cfgstore-'))
const configPath = join(dir, 'manager.config.yaml')
const envPath = join(dir, '.env')

const withEnv = (): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(envPath, 'SESSION_SECRET=store-test-secret-0123456789abcdef0123456789abcdef\n', 'utf8')
}

const seedConfig = (): string => {
  const text = [
    '# Top-level comment -- this is the documentation body of the manual-edit entry point and must never be lost',
    'listen:',
    '  host: 127.0.0.1',
    '  port: 8080',
    '',
    '# Endpoint A: loopback direct connection',
    'endpoints:',
    '  A:',
    '    url: http://127.0.0.1:3080',
    '    driver: apiproxy',
    '    prefix: /api',
    '    key_ref: \'\'',
    '',
    'agents:',
    '  personal:',
    '    name: 个人',
    '    endpoint: A',
    '    workspace: ./workspaces/personal',
  ].join('\n')
  writeFileSync(configPath, text, 'utf8')
  return text
}

test('Debt A3 regression: comments and manual formatting survive -- a mutate loses not a single character of the original comments', () => {
  withEnv()
  const before = seedConfig()
  mutateYamlFile(configPath, (doc) => {
    doc.setIn(['agents', 'product'], { name: '产品', endpoint: 'A', workspace: './workspaces/product' })
  })
  const after = readFileSync(configPath, 'utf8')
  assert.ok(after.includes('# Top-level comment -- this is the documentation body of the manual-edit entry point and must never be lost'), 'the top-level comment must survive')
  assert.ok(after.includes('# Endpoint A: loopback direct connection'), 'the in-section comment must survive')
  assert.ok(after.includes('product'), 'the newly added key must take effect')
  assert.notEqual(after, before)
})

test('Debt A3 regression: a failed full validation -> the previous revision is restored and an error is thrown; a bad config never lands on disk', () => {
  withEnv()
  const before = seedConfig()
  assert.throws(
    () => mutateYamlFile(configPath, (doc) => {
      doc.deleteIn(['endpoints'])
    }, { validate: 'full' }),
    /validation failed|at least one endpoint/,
  )
  assert.equal(readFileSync(configPath, 'utf8'), before, 'a failed validation must restore the original text')
})

test('Debt A3 regression: an atomic write leaves no .tmp behind; the content lands on disk in full', () => {
  const out = join(dir, 'atom.txt')
  writeFileAtomic(out, 'hello-atomic', 0o600)
  assert.equal(readFileSync(out, 'utf8'), 'hello-atomic')
  assert.equal(existsSync(`${out}.tmp`), false, 'no .tmp may be left behind')
})

test('Debt R10 regression: when rename cannot replace a mount point (EBUSY) it falls back to writing in place -- the content lands and no .tmp is left', () => {
  const out = join(dir, 'mounted.env')
  writeFileSync(out, 'OLD=1\n', 'utf8')
  const body = 'SESSION_SECRET=store-test-secret-0123456789abcdef0123456789abcdef\nNEW=2\n'
  writeFileAtomic(out, body, 0o600, {
    // A file-level bind mount in the container form (./.env:/app/.env) cannot be replaced by rename on
    // Linux (EBUSY) -- proven by compose-e2e: POST /api/nodes returned 500 EBUSY rename .env.tmp
    rename: () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
    },
  })
  assert.equal(readFileSync(out, 'utf8'), body, 'the in-place fallback must land the content in full')
  assert.equal(existsSync(`${out}.tmp`), false, 'the fallback path must leave no .tmp behind')
})

test('Debt A3 regression: concurrent writes serialize through the lock -- neither update is lost', async () => {
  withEnv()
  seedConfig()
  await Promise.all([
    withConfigLock(() => mutateYamlFile(configPath, (doc) => {
      doc.setIn(['agents', 'company'], { name: '企业', endpoint: 'A', workspace: './workspaces/company' })
    })),
    withConfigLock(() => mutateYamlFile(configPath, (doc) => {
      doc.setIn(['agents', 'product'], { name: '产品', endpoint: 'A', workspace: './workspaces/product' })
    })),
  ])
  const after = readFileSync(configPath, 'utf8')
  assert.ok(after.includes('company') && after.includes('product'), 'both concurrent updates must land on disk')
})

test('Debt R6: an existing YAML with a syntax error must refuse the rewrite -- errors must not be dropped silently', () => {
  withEnv()
  const broken = 'listen:\n  port: 8080\nendpoints:\n  A:\n    url: http://x\n   bad_indent: [unclosed\n'
  writeFileSync(configPath, broken, 'utf8')
  assert.throws(
    () => mutateYamlFile(configPath, (doc) => {
      doc.setIn(['agents', 'x'], { name: 'x', endpoint: 'A', workspace: './w' })
    }),
    /syntax/,
  )
  assert.equal(readFileSync(configPath, 'utf8'), broken, 'a config with a syntax error must not be rewritten (the erroneous fragment would be dropped)')
})

// Wrap-up: clean the temp directory before the test file ends (the dir is shared between tests, which run in order)
after(() => {
  rmSync(dir, { recursive: true, force: true })
})
