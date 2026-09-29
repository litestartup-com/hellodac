import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderOutwardAgentDoc, syncOutwardAgentDocs, AGENTS_FILE, OUTWARD_DOC_MARK } from './outward-doc.js'
import { DEFAULT_PRICING } from '../pricing.js'
import type { AppConfig } from '../config.js'

/**
 * The outward rules doc (2026-09-29, the ask_user_question hang): a public agent's AGENTS.md is
 * manager-owned — platform rules + the service persona — while a private agent's workspace is
 * never touched. These tests pin the render, the public-only sync, the idempotence and the
 * persona round trip from the declaration.
 */
const configFor = (): AppConfig => {
  const root = mkdtempSync(join(tmpdir(), 'outward-doc-'))
  return {
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: {
      svc: { id: 'svc', url: 'http://node-svc:3081', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null, access: null },
      personal: { id: 'personal', url: 'http://node-personal:3082', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null, access: null },
    },
    agents: {
      'svc-chat-1': { id: 'svc-chat-1', name: 'Support 1', endpoint: 'svc', workspacePath: join(root, 'svc'), public: true, preset: 'standard', sandboxMode: 'read-only', gitRemote: null, provider: 'deepseek-official', model: 'deepseek-v4-flash', validate: null },
      personal: { id: 'personal', name: 'Personal', endpoint: 'personal', workspacePath: join(root, 'personal'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null, validate: null },
    },
    services: [
      {
        id: 'chat',
        label: 'Support',
        workers: ['svc-chat-1'],
        surfaces: ['conversations'],
        knowledge: [],
        persona: 'You are the support voice of Acme. Be warm, brief, and never guess a price.',
      },
    ],
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
}

test('outward doc: the render carries the platform rules (never block on a prompt), the service identity and the persona', () => {
  const doc = renderOutwardAgentDoc({ id: 'svc-chat-1', name: 'Support 1' }, { label: 'Support', persona: 'Be warm, brief.' })
  assert.match(doc, /Outward service agent rules/)
  assert.match(doc, /Never\*\* use `ask_user_question`/, 'the rule that prevents the 2026-09-29 hang is spelled out')
  assert.match(doc, /ask your question in the reply text/, 'the alternative behaviour is spelled out too')
  assert.match(doc, /Never wait on a tool approval/, 'approvals hang the same way questions do')
  assert.match(doc, /never invent prices, policies, or facts/)
  assert.match(doc, /Support 1/)
  assert.match(doc, /"Support"/)
  assert.match(doc, /Be warm, brief\./, 'the declared persona rides along verbatim')
})

test('outward doc: no declared persona falls back to the neutral support voice, and a public agent no declaration claims still gets the rules', () => {
  const doc = renderOutwardAgentDoc({ id: 'svc-x', name: 'X' }, null)
  assert.match(doc, /\(none declared\)/)
  assert.match(doc, /No service-specific persona is declared/)
  assert.match(doc, /Never\*\* use `ask_user_question`/)
})

test('outward doc: sync writes public agents only, is idempotent, and follows a persona change', async () => {
  const config = configFor()
  const personal = config.agents.personal
  const svc = config.agents['svc-chat-1']
  assert.ok(personal !== undefined && svc !== undefined)
  // The private agent has a hand-written AGENTS.md that must survive untouched.
  const personalAgents = join(personal.workspacePath, AGENTS_FILE)
  mkdirSync(personal.workspacePath, { recursive: true })
  writeFileSync(personalAgents, 'My own private rules.\n', 'utf8')

  const updated = await syncOutwardAgentDocs(config)
  assert.deepEqual(updated, ['svc-chat-1'], 'only the public agent is (re)written')

  const svcPath = join(svc.workspacePath, AGENTS_FILE)
  assert.ok(existsSync(svcPath))
  const written = readFileSync(svcPath, 'utf8')
  assert.ok(written.startsWith(OUTWARD_DOC_MARK))
  assert.match(written, /never guess a price/, 'the declared persona is in the delivered file')
  assert.equal(readFileSync(personalAgents, 'utf8'), 'My own private rules.\n', 'a private workspace is user-owned and never touched')

  assert.deepEqual(await syncOutwardAgentDocs(config), [], 'identical content is not rewritten')

  const service = config.services?.[0]
  assert.ok(service !== undefined)
  service.persona = 'New voice: terse and formal.'
  assert.deepEqual(await syncOutwardAgentDocs(config), ['svc-chat-1'], 'a persona change re-renders the doc')
  assert.match(readFileSync(svcPath, 'utf8'), /terse and formal/)
})

test('outward doc: a remote (agent-runner) node is skipped -- its workspacePath is on the other machine, and writing it locally would fabricate a junk tree', async () => {
  const config = configFor()
  const svcEndpoint = config.endpoints.svc
  assert.ok(svcEndpoint !== undefined)
  config.endpoints.svc = {
    ...svcEndpoint,
    spawn: {
      managed: true, command: 'node', args: [], cwd: null, readyTimeoutMs: 30_000, detached: false, logFile: null,
      env: {}, restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 }, runner: 'agent', host: 'box-33', docker: null,
    },
  }
  const notes: string[] = []
  assert.deepEqual(await syncOutwardAgentDocs(config, (line) => notes.push(line)), [])
  assert.ok(!existsSync(join(config.agents['svc-chat-1']!.workspacePath, AGENTS_FILE)), 'nothing is written for the remote path')
  assert.ok(notes.some((line) => line.includes('spawn payload')), 'the skip is logged with the reason')
})
