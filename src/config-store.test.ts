import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mutateYamlFile, withConfigLock, writeFileAtomic } from './config-store.js'

/**
 * 债务 A3:真相源 manager.config.yaml 的原子写。
 * 旧代码 read→parse(JS 对象)→stringify→直写:丢注释、崩溃截断、无写后校验。
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
    '# 顶层注释——这是手改入口的文档本体,绝不能丢',
    'listen:',
    '  host: 127.0.0.1',
    '  port: 8080',
    '',
    '# 端点 A:loopback 直连',
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

test('债务 A3 回归: 注释与手工格式保留——mutate 后原注释一字不丢', () => {
  withEnv()
  const before = seedConfig()
  mutateYamlFile(configPath, (doc) => {
    doc.setIn(['agents', 'product'], { name: '产品', endpoint: 'A', workspace: './workspaces/product' })
  })
  const after = readFileSync(configPath, 'utf8')
  assert.ok(after.includes('# 顶层注释——这是手改入口的文档本体,绝不能丢'), '顶层注释必须保留')
  assert.ok(after.includes('# 端点 A:loopback 直连'), '段内注释必须保留')
  assert.ok(after.includes('product'), '新增 key 必须生效')
  assert.notEqual(after, before)
})

test('债务 A3 回归: full 校验失败 → 自动还原上一版并抛错,坏配置绝不落盘', () => {
  withEnv()
  const before = seedConfig()
  assert.throws(
    () => mutateYamlFile(configPath, (doc) => {
      doc.deleteIn(['endpoints'])
    }, { validate: 'full' }),
    /validation failed|at least one endpoint/,
  )
  assert.equal(readFileSync(configPath, 'utf8'), before, '校验失败必须还原原文')
})

test('债务 A3 回归: 原子写不残留 .tmp;内容完整落盘', () => {
  const out = join(dir, 'atom.txt')
  writeFileAtomic(out, 'hello-atomic', 0o600)
  assert.equal(readFileSync(out, 'utf8'), 'hello-atomic')
  assert.equal(existsSync(`${out}.tmp`), false, '不得残留 .tmp')
})

test('债务 R10 回归: rename 顶不动挂载点(EBUSY)时回落原地写——内容落盘且不残留 .tmp', () => {
  const out = join(dir, 'mounted.env')
  writeFileSync(out, 'OLD=1\n', 'utf8')
  const body = 'SESSION_SECRET=store-test-secret-0123456789abcdef0123456789abcdef\nNEW=2\n'
  writeFileAtomic(out, body, 0o600, {
    // 容器形态的文件级 bind mount（./.env:/app/.env）在 Linux 上不能被 rename
    // 顶替（EBUSY）——compose-e2e 实证：POST /api/nodes 500 EBUSY rename .env.tmp
    rename: () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
    },
  })
  assert.equal(readFileSync(out, 'utf8'), body, '回落原地写必须完整落盘')
  assert.equal(existsSync(`${out}.tmp`), false, '回落路径不得残留 .tmp')
})

test('债务 A3 回归: 并发写经锁串行——两处更新都不丢', async () => {
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
  assert.ok(after.includes('company') && after.includes('product'), '两个并发更新都必须落盘')
})

test('债务 R6: 带语法错误的既有 YAML 必须拒绝改写——errors 不得被静默丢弃', () => {
  withEnv()
  const broken = 'listen:\n  port: 8080\nendpoints:\n  A:\n    url: http://x\n   bad_indent: [unclosed\n'
  writeFileSync(configPath, broken, 'utf8')
  assert.throws(
    () => mutateYamlFile(configPath, (doc) => {
      doc.setIn(['agents', 'x'], { name: 'x', endpoint: 'A', workspace: './w' })
    }),
    /syntax/,
  )
  assert.equal(readFileSync(configPath, 'utf8'), broken, '带语法错误的配置不得被改写(错误片段会被丢弃)')
})

// 收尾:测试文件结束前清理临时目录(测试间共享 dir,顺序执行)
after(() => {
  rmSync(dir, { recursive: true, force: true })
})
