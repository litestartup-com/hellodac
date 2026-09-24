import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updateManager, type UpdateDeps } from './update.js'

/** 状态化 git 桩 + 调用序列记录，覆盖 update 的全部分支。 */
const harness = (options: {
  dirty?: boolean
  heads?: [string, string]
  fetchFail?: boolean
  pullFail?: boolean
  buildFail?: boolean
  probe?: boolean
}): { deps: UpdateDeps; calls: string[] } => {
  const calls: string[] = []
  let revs = 0
  const heads = options.heads ?? ['aaaa1111', 'bbbb2222']
  const deps: UpdateDeps = {
    git: (args) => {
      calls.push(`git ${args.join(' ')}`)
      if (args[0] === 'status') return options.dirty === true ? ' M src/x.ts' : ''
      if (args[0] === 'fetch') {
        if (options.fetchFail === true) throw new Error('fetch failed')
        return ''
      }
      if (args[0] === 'pull') {
        if (options.pullFail === true) throw new Error('pull failed')
        return ''
      }
      if (args[0] === 'rev-parse') {
        revs += 1
        return revs === 1 ? heads[0] : heads[1]
      }
      if (args[0] === 'reset') return ''
      return ''
    },
    run: () => {},
    npm: (args) => {
      calls.push(`npm ${args.join(' ')}`)
      if (options.buildFail === true && args[0] === 'run') throw new Error('build failed')
    },
    probe: async () => options.probe ?? true,
    backup: async () => {
      calls.push('backup')
      return 'snap-1'
    },
    log: () => {},
    startProbeInstance: () => ({
      stop: () => calls.push('probe-stop'),
    }),
  }
  return { deps, calls }
}

test('蜂群 P6 update: a dirty tree refuses before anything else', async () => {
  const { deps, calls } = harness({ dirty: true })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, false)
  assert.match(result.detail, /uncommitted changes/)
  assert.ok(!calls.includes('backup'), '脏工作树不做备份就中止')
})

test('蜂群 P6 update: already latest short-circuits', async () => {
  const { deps, calls } = harness({ heads: ['same0000', 'same0000'] })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, true)
  assert.match(result.detail, /already up to date/)
  assert.ok(!calls.some((c) => c.startsWith('npm')), '无变更不重建')
})

test('蜂群 P6 update: clean pull + build + probe ok reports success', async () => {
  const { deps, calls } = harness({ probe: true })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, true)
  assert.match(result.detail, /update complete/)
  assert.ok(calls.includes('backup'), '更新前必备份')
  assert.ok(calls.some((c) => c === 'npm install'), '重新安装依赖')
  assert.ok(calls.some((c) => c === 'npm run build'), '重新构建')
  assert.ok(calls.includes('probe-stop'), '探活实例被回收')
})

test('蜂群 P6 update: probe failure rolls back and rebuilds', async () => {
  const { deps, calls } = harness({ probe: false })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, false)
  assert.match(result.detail, /rolled back/)
  assert.ok(calls.some((c) => c === 'git reset --hard aaaa1111'), '回滚到旧提交')
  const buildCalls = calls.filter((c) => c === 'npm run build')
  assert.equal(buildCalls.length, 2, '新版本一次 + 回滚后一次')
})

test('蜂群 P6 update: build failure also rolls back', async () => {
  const { deps, calls } = harness({ buildFail: true })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, false)
  assert.match(result.detail, /the build failed/)
  assert.ok(calls.some((c) => c === 'git reset --hard aaaa1111'))
})

test('蜂群 P6 update: unreachable remote and diverged pull refuse cleanly', async () => {
  const fetchFail = harness({ fetchFail: true })
  const r1 = await updateManager(fetchFail.deps, '/repo')
  assert.equal(r1.ok, false)
  assert.match(r1.detail, /git fetch failed/)

  const pullFail = harness({ pullFail: true })
  const r2 = await updateManager(pullFail.deps, '/repo')
  assert.equal(r2.ok, false)
  assert.match(r2.detail, /git pull failed/)
})
