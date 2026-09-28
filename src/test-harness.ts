// Debt C3: a shared test harness -- temp dirs / makeDb / personalAgent consolidated.
//
// Before this, 14+ test files each carried their own copy of makeDb/agentFor and the variants had started to drift
// (some agents were written to the DB and some were not, fields were missing provider/model/sandboxMode).
// One implementation = one meaning: any change to the DB shape or to a ResolvedAgent field is made here only.
//
// configFor stays out of the harness: its endpoint shape follows the FakeGateway/real gateway, and forcing it to be
// uniform would turn "fake dependency injection" into "implicit network" -- leaving it in each test is more honest.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedAgent } from './config.js'
import { openDb, schema, type Db } from './db/index.js'

/** A standalone temp directory; the caller cleans it up when the test ends (or the process exits). */
export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), `${prefix}-`))

/** Open a bare test database file (no agent rows written). */
const openTestDb = (): { db: Db; dir: string } => {
  const dir = tempDir('harness-db')
  const { db } = openDb(join(dir, 'test.db'))
  return { db, dir }
}

/**
 * Open a file DB that carries the personal agent row.
 * The directory is returned so tests can reach the DB file path (backup/migration cases).
 */
export const makeDb = (workspace?: string): { db: Db; dir: string; workspace: string } => {
  const { db, dir } = openTestDb()
  const ws = workspace ?? tempDir('harness-ws')
  db.insert(schema.agent)
    .values({
      id: 'personal',
      name: 'Personal',
      workspacePath: ws,
      endpoint: 'A',
      preset: null,
      gitRemote: null,
      public: 0,
      createdAt: Date.now(),
    })
    .run()
  return { db, dir, workspace: ws }
}

/** A ResolvedAgent matching the personal row makeDb writes (endpoint A). */
export const personalAgent = (workspacePath: string): ResolvedAgent =>
  agentWith({ id: 'personal', name: 'Personal', workspacePath })

/**
 * ResolvedAgent construction with parameters: tests such as skills/status use a different id/name/endpoint,
 * and every other field gets the same empty default -- a field-shape change is made here only.
 */
export const agentWith = (over: {
  id: string
  name: string
  workspacePath: string
  endpoint?: string
  public?: boolean
  preset?: string | null
  sandboxMode?: ResolvedAgent['sandboxMode']
}): ResolvedAgent => ({
  id: over.id,
  name: over.name,
  endpoint: over.endpoint ?? 'A',
  workspacePath: over.workspacePath,
  public: over.public ?? false,
  preset: over.preset ?? null,
  gitRemote: null,
  provider: null,
  model: null,
  sandboxMode: over.sandboxMode ?? null,
  validate: null,
})

/**
 * A multi-agent test DB (usage/status use the personal + company rows).
 * Only the given rows are written (no default personal); workspacePath defaults to the DB directory, endpoint to 'A'.
 */
export const makeDbWithAgents = (agents: Array<{ id: string; name?: string; workspacePath?: string; endpoint?: string }>): Db => {
  const { db, dir } = openTestDb()
  for (const agent of agents) {
    db.insert(schema.agent)
      .values({
        id: agent.id,
        name: agent.name ?? agent.id,
        workspacePath: agent.workspacePath ?? dir,
        endpoint: agent.endpoint ?? 'A',
        preset: null,
        gitRemote: null,
        public: 0,
        createdAt: 0,
      })
      .run()
  }
  return db
}
