import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updateManager, type UpdateDeps } from './update.js'

/** A stateful git stub plus a call-sequence record, covering every branch of update. */
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

test('Hive P6 update: a dirty tree refuses before anything else', async () => {
  const { deps, calls } = harness({ dirty: true })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, false)
  assert.match(result.detail, /uncommitted changes/)
  assert.ok(!calls.includes('backup'), 'a dirty worktree aborts before any backup')
})

test('Hive P6 update: already latest short-circuits', async () => {
  const { deps, calls } = harness({ heads: ['same0000', 'same0000'] })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, true)
  assert.match(result.detail, /already up to date/)
  assert.ok(!calls.some((c) => c.startsWith('npm')), 'no change, no rebuild')
})

test('Hive P6 update: clean pull + build + probe ok reports success', async () => {
  const { deps, calls } = harness({ probe: true })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, true)
  assert.match(result.detail, /update complete/)
  assert.ok(calls.includes('backup'), 'a backup is mandatory before updating')
  assert.ok(calls.some((c) => c === 'npm install'), 'dependencies are reinstalled')
  assert.ok(calls.some((c) => c === 'npm run build'), 'the build is rerun')
  assert.ok(calls.includes('probe-stop'), 'the probe instance is reclaimed')
})

test('Hive P6 update: probe failure rolls back and rebuilds', async () => {
  const { deps, calls } = harness({ probe: false })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, false)
  assert.match(result.detail, /rolled back/)
  assert.ok(calls.some((c) => c === 'git reset --hard aaaa1111'), 'rolls back to the previous commit')
  const buildCalls = calls.filter((c) => c === 'npm run build')
  assert.equal(buildCalls.length, 2, 'one for the new version + one after the rollback')
})

test('Hive P6 update: build failure also rolls back', async () => {
  const { deps, calls } = harness({ buildFail: true })
  const result = await updateManager(deps, '/repo')
  assert.equal(result.ok, false)
  assert.match(result.detail, /the build failed/)
  assert.ok(calls.some((c) => c === 'git reset --hard aaaa1111'))
})

test('Hive P6 update: unreachable remote and diverged pull refuse cleanly', async () => {
  const fetchFail = harness({ fetchFail: true })
  const r1 = await updateManager(fetchFail.deps, '/repo')
  assert.equal(r1.ok, false)
  assert.match(r1.detail, /git fetch failed/)

  const pullFail = harness({ pullFail: true })
  const r2 = await updateManager(pullFail.deps, '/repo')
  assert.equal(r2.ok, false)
  assert.match(r2.detail, /git pull failed/)
})
