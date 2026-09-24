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

test('舰队 M3-3: agent 掉线边沿触发进铃铛——online 基线静默、掉线一报、恢复一报、重复不掉线不重报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'))
  const opened = openDb(join(dir, 'test.db'))
  try {
    const { db } = opened
    const agents = [{ id: 'agent-a1', hostname: 'box-1', online: true }]
    const tick = createFleetWatchdog({ db, agents: () => agents, nodeStates: () => [] })

    tick()
    assert.equal(unreadOf(db, 'agent_offline').length, 0, '在线基线不报')

    agents[0]!.online = false
    tick()
    assert.equal(unreadOf(db, 'agent_offline').length, 1, '掉线只报一次')
    assert.match(unreadOf(db, 'agent_offline')[0]!.body, /box-1/, '正文带主机名')

    tick()
    assert.equal(unreadOf(db, 'agent_offline').length, 1, '持续掉线不重复报')

    agents[0]!.online = true
    tick()
    assert.equal(unreadOf(db, 'agent_recovered').length, 1, '恢复上报')
  } finally {
    opened.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('舰队 M3-3: agent 节点异常进铃铛——仅 agent runner 的 offline 触发，process runner 不越界', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'))
  const opened = openDb(join(dir, 'test.db'))
  try {
    const { db } = opened
    const nodes = [
      { id: 'ops01', state: 'offline', runner: 'agent', host: 'agent-a1', lastError: 'agent 报告 spawn 失败（指令 #3）' },
      { id: 'personal', state: 'offline', runner: 'process', host: null, lastError: 'boom' },
    ]
    const tick = createFleetWatchdog({ db, agents: () => [], nodeStates: () => nodes })

    tick()
    assert.equal(unreadOf(db, 'node_offline').length, 1, 'agent 节点掉线只报一次')
    assert.match(unreadOf(db, 'node_offline')[0]!.body, /ops01/, '正文带节点名')
    assert.match(unreadOf(db, 'node_offline')[0]!.body, /spawn 失败/, '正文带原因')

    tick()
    assert.equal(unreadOf(db, 'node_offline').length, 1, '持续异常不重复报')

    nodes[0]!.state = 'live'
    tick()
    assert.equal(unreadOf(db, 'node_recovered').length, 1, '节点恢复上报')
  } finally {
    opened.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('舰队 M3-3: manager 重启不刷屏——铃铛已有同 agent 未读告警时不再重复插入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'))
  const opened = openDb(join(dir, 'test.db'))
  try {
    const { db } = opened
    notify(db, { kind: 'agent_offline', title: '机器 box-1 掉线', body: '机器 box-1（agent-a1）超过 90 秒未上报心跳', link: '/nodes' })
    const agents = [{ id: 'agent-a1', hostname: 'box-1', online: false }]
    const tick = createFleetWatchdog({ db, agents: () => agents, nodeStates: () => [] })
    tick()
    assert.equal(unreadOf(db, 'agent_offline').length, 1, '已有未读告警 = 不再插入（重启场景）')
  } finally {
    opened.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
