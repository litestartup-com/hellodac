import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, schema } from '../db/index.js'
import { archiveOrphanChats, createChat, getChat } from './store.js'

test('Hive plan 2 P6 regression: orphan chat archiving -- a chat whose agent left is soft-archived, one whose agent is still there is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-chats-'))
  const { db } = openDb(join(dir, 'test.db'))
  for (const id of ['brain', 'personal', 'product']) {
    db.insert(schema.agent).values({ id, name: id, workspacePath: dir, endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: Date.now() }).run()
  }
  const brain = createChat(db, 'brain')
  // The real scenario: the agent row exists when product creates the chat; after the node is deleted it is gone from config but the DB row stays (billing audit)
  const product = createChat(db, 'product')
  assert.ok(getChat(db, brain.id)?.removedAt === null)
  assert.ok(getChat(db, product.id)?.removedAt === null)

  const archived = archiveOrphanChats(db, new Set(['brain', 'personal']))
  assert.equal(archived, 1)
  assert.ok(getChat(db, product.id)?.removedAt !== null, 'the orphan chat is soft-archived')
  assert.ok(getChat(db, brain.id)?.removedAt === null, 'a chat of an agent that is still here is untouched')

  // Idempotent: running it again adds nothing
  assert.equal(archiveOrphanChats(db, new Set(['brain', 'personal'])), 0)
})
