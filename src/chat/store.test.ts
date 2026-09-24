import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, schema } from '../db/index.js'
import { archiveOrphanChats, createChat, getChat } from './store.js'

test('蜂群2计划 P6 回归: 孤儿会话归档——agent 离场的会话软归档，在场的不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-chats-'))
  const { db } = openDb(join(dir, 'test.db'))
  for (const id of ['brain', 'personal', 'product']) {
    db.insert(schema.agent).values({ id, name: id, workspacePath: dir, endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: Date.now() }).run()
  }
  const brain = createChat(db, 'brain')
  // 真实场景：product 建会话时 agent 行存在；删节点后 config 里没了、DB 行保留（账单审计）
  const product = createChat(db, 'product')
  assert.ok(getChat(db, brain.id)?.removedAt === null)
  assert.ok(getChat(db, product.id)?.removedAt === null)

  const archived = archiveOrphanChats(db, new Set(['brain', 'personal']))
  assert.equal(archived, 1)
  assert.ok(getChat(db, product.id)?.removedAt !== null, '孤儿会话被软归档')
  assert.ok(getChat(db, brain.id)?.removedAt === null, '在场 agent 的会话不动')

  // 幂等：再跑一遍无新增
  assert.equal(archiveOrphanChats(db, new Set(['brain', 'personal'])), 0)
})
