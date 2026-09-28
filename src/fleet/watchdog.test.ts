import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFleetWatchdog } from './watchdog.js'
import { openDb } from '../db/index.js'
import { schema } from '../db/index.js'
import { notify } from '../notify.js'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const unreadOf = (db: ReturnType<typeof openDb>['db'], kind: string) =>
  db.select().from(schema.notification).all().filter((n) => n.kind === kind && n.read === 0)

test('Fleet M3-3: an agent going offline is edge-triggered into the bell -- the online baseline is silent, one report on going offline, one on recovery, and no repeat while it stays down', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'))
  const opened = openDb(join(dir, 'test.db'))
  try {
    const { db } = opened
    const agents = [{ id: 'agent-a1', hostname: 'box-1', online: true }]
    const tick = createFleetWatchdog({ db, agents: () => agents, nodeStates: () => [] })

    tick()
    assert.equal(unreadOf(db, 'agent_offline').length, 0, 'the online baseline reports nothing')

    agents[0]!.online = false
    tick()
    assert.equal(unreadOf(db, 'agent_offline').length, 1, 'going offline is reported once')
    assert.match(unreadOf(db, 'agent_offline')[0]!.body, /box-1/, 'the body carries the hostname')

    tick()
    assert.equal(unreadOf(db, 'agent_offline').length, 1, 'staying offline is not reported again')

    agents[0]!.online = true
    tick()
    assert.equal(unreadOf(db, 'agent_recovered').length, 1, 'recovery is reported')
  } finally {
    opened.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Fleet M3-3: an abnormal agent node goes into the bell -- only an agent runner going offline triggers it; a process runner stays out of it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'))
  const opened = openDb(join(dir, 'test.db'))
  try {
    const { db } = opened
    const nodes = [
      { id: 'ops01', state: 'offline', runner: 'agent', host: 'agent-a1', lastError: 'the agent reported a spawn failure (command #3)' },
      { id: 'personal', state: 'offline', runner: 'process', host: null, lastError: 'boom' },
    ]
    const tick = createFleetWatchdog({ db, agents: () => [], nodeStates: () => nodes })

    tick()
    assert.equal(unreadOf(db, 'node_offline').length, 1, 'an offline agent node is reported once')
    assert.match(unreadOf(db, 'node_offline')[0]!.body, /ops01/, 'the body carries the node name')
    assert.match(unreadOf(db, 'node_offline')[0]!.body, /spawn failure/, 'the body carries the reason')

    tick()
    assert.equal(unreadOf(db, 'node_offline').length, 1, 'a continuing fault is not reported again')

    nodes[0]!.state = 'live'
    tick()
    assert.equal(unreadOf(db, 'node_recovered').length, 1, 'node recovery is reported')
  } finally {
    opened.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Fleet M3-3: a manager restart does not flood the bell -- with an unread alert for the same agent already there, nothing more is inserted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'))
  const opened = openDb(join(dir, 'test.db'))
  try {
    const { db } = opened
    notify(db, { kind: 'agent_offline', title: 'machine box-1 went offline', body: 'machine box-1（agent-a1）has not sent a heartbeat for over 90s', link: '/nodes' })
    const agents = [{ id: 'agent-a1', hostname: 'box-1', online: false }]
    const tick = createFleetWatchdog({ db, agents: () => agents, nodeStates: () => [] })
    tick()
    assert.equal(unreadOf(db, 'agent_offline').length, 1, 'an unread alert already there = insert nothing more (the restart case)')
  } finally {
    opened.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
