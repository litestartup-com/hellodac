import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { GATEWAY_PACKAGE, SUPPORTED_DSH } from '../dsh-matrix.js'
import { LEGACY_PEER_PINS } from '../host-node/profile.js'

/**
 * 容器节点镜像的依赖锁（事实卡 §14「容器遗留」）。
 *
 * `images/node/gen-node-profile.mjs` 在构建期现解依赖树；没有锁文件时，同样的镜像
 * tag 会因为 registry 漂移装出不同的树——出事无法复现，也无法回滚到"那一棵树"。
 * 这两个锁由该脚本自己的 `--lock-only` 模式生成（与构建期写入的 package.json 同一份
 * 逻辑），随仓库提交；本测试负责挡住"改了钉版却没刷新锁"。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const lockDir = join(root, 'images', 'node', 'profile-lock')

interface Lock {
  lockfileVersion: number
  packages: Record<string, { name?: string; dependencies?: Record<string, string> }>
}

const readLock = (version: string): Lock => {
  const file = join(lockDir, `${version}.package-lock.json`)
  assert.ok(existsSync(file), `缺锁文件 ${version}.package-lock.json（跑 npm run lock:profile 刷新）`)
  return JSON.parse(readFileSync(file, 'utf8')) as Lock
}

test('DAC v1.0.0: 每个受支持 DSH 版本都有容器 profile 锁，且根依赖与共享真相源一致', () => {
  for (const pair of SUPPORTED_DSH) {
    const lock = readLock(pair.dsh)
    assert.ok(lock.lockfileVersion >= 3, `${pair.dsh} 锁版本过低`)
    const rootPkg = lock.packages['']
    assert.ok(rootPkg !== undefined, `${pair.dsh} 锁缺根包`)
    assert.equal(rootPkg.name, 'dsh-profile-dac-node', '根包名必须与 gen-node-profile 写的一致')
    // 与 src/host-node/profile.ts 的 profileDependencies 同源（容器 profile 少一个
    // 裸 @deepseek-ai/dsh 直依赖，那是裸机路径的入口包）。
    const expected: Record<string, string> = {
      '@deepseek-ai/dsh-base': pair.dsh,
      '@deepseek-ai/dsh-web-app': pair.dsh,
      [GATEWAY_PACKAGE]: pair.gateway,
      ...(LEGACY_PEER_PINS[pair.dsh] ?? {}),
    }
    assert.deepEqual(rootPkg.dependencies, expected, `${pair.dsh} 锁与矩阵/钉版不一致——刷新锁再提交`)
  }
})

test('DAC v1.0.0: 锁里落的是完整解析树（不是空壳），且没有 file: 本地路径依赖', () => {
  for (const pair of SUPPORTED_DSH) {
    const lock = readLock(pair.dsh)
    const entries = Object.keys(lock.packages).length
    assert.ok(entries > 100, `${pair.dsh} 锁只有 ${entries} 条，像是没真正解析`)
    for (const [path, pkg] of Object.entries(lock.packages)) {
      for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
        assert.ok(!spec.startsWith('file:'), `${pair.dsh} 锁里出现本地路径依赖 ${name}=${spec}（镜像里不存在）`)
      }
      assert.ok(!path.includes('..'), `${pair.dsh} 锁里有越界路径 ${path}`)
    }
  }
})
