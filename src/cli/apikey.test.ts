import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../db/index.js'
import { createKey, parseKeyArgs, renderKeyList, unknownServices } from './apikey.js'

/**
 * The contract of the key CLI (the acceptance steps hand out keys through it):
 * - dangerous defaults lean to the safe side: a read-only scope, services that must be given explicitly, and a daily quota by default;
 * - the plaintext is printed once at creation; the list never prints plaintext.
 */
test('CLI arguments: create requires name and services (no "passes everything" default)', () => {
  const missing = parseKeyArgs(['create'])
  assert.ok('error' in missing, 'missing arguments must be an error')
  assert.match(String(missing.error), /name/)

  const noServices = parseKeyArgs(['create', '--name', 'x'])
  assert.ok('error' in noServices)
  assert.match(String(noServices.error), /services/)

  const ok = parseKeyArgs(['create', '--name', 'Company backend', '--services', 'support,report', '--scopes', 'services:read,tasks:write'])
  assert.ok(!('error' in ok))
  if (!('error' in ok) && ok.command === 'create') {
    assert.deepEqual(ok.options.scopeServices, ['support', 'report'])
    assert.deepEqual(ok.options.scopes, ['services:read', 'tasks:write'])
    assert.equal(ok.options.quotaRunsDay, 200, 'a daily quota by default (stated plainly, and --quota none lifts it)')
    assert.equal(ok.options.rateLimitRpm, 60)
    assert.equal(ok.options.maxConcurrency, 4)
  }
})

test('CLI arguments: a read-only default scope / --all-services / --quota none / an unknown scope errors', () => {
  const readOnly = parseKeyArgs(['create', '--name', 'x', '--services', 'support'])
  assert.ok(!('error' in readOnly))
  if (!('error' in readOnly) && readOnly.command === 'create') {
    assert.deepEqual(readOnly.options.scopes, ['services:read', 'usage:read'], 'read-only by default')
    assert.equal(readOnly.options.expiresAt, null)
  }

  const wild = parseKeyArgs(['create', '--name', 'x', '--all-services', '--quota', 'none'])
  assert.ok(!('error' in wild))
  if (!('error' in wild) && wild.command === 'create') {
    assert.deepEqual(wild.options.scopeServices, ['*'])
    assert.equal(wild.options.quotaRunsDay, null)
  }

  const badScope = parseKeyArgs(['create', '--name', 'x', '--services', 'support', '--scopes', 'root:all'])
  assert.ok('error' in badScope)
  assert.match(String(badScope.error), /unknown scope/)
})

test('CLI arguments: revoke needs an id; list/help take none', () => {
  assert.ok('error' in parseKeyArgs(['revoke']))
  const revoke = parseKeyArgs(['revoke', 'abcdef123456'])
  assert.ok(!('error' in revoke) && revoke.command === 'revoke' && revoke.id === 'abcdef123456')
  assert.ok(!('error' in parseKeyArgs(['list'])))
  assert.ok(!('error' in parseKeyArgs(['help'])))
  assert.ok('error' in parseKeyArgs(['frobnicate']))
})

test('CLI create: the plaintext comes back once and only a hash lands in the database; the list carries no plaintext', () => {
  const { db } = openDb(':memory:')
  const parsed = parseKeyArgs(['create', '--name', 'Company backend', '--services', 'support', '--scopes', 'services:read,tasks:write', '--quota', '50'])
  assert.ok(!('error' in parsed) && parsed.command === 'create')
  if ('error' in parsed || parsed.command !== 'create') return

  const { token, key } = createKey(db, parsed.options)
  assert.match(token, /^dac_[0-9a-f]{12}_/)
  assert.equal(key.quotaRunsDay, 50)

  const listing = renderKeyList([key], Date.now())
  assert.ok(listing.includes(key.id))
  assert.ok(listing.includes('Company backend'))
  assert.ok(!listing.includes(token.split('_')[2] ?? 'x'), 'the list never prints plaintext')
  assert.match(listing, /50\/day/)
})

test('CLI service-name validation: the same rule as the UI (a key given a wrong name "looks normal yet gets into no service")', () => {
  const parsed = parseKeyArgs(['create', '--name', 'x', '--services', 'suport,support'])
  assert.ok(!('error' in parsed) && parsed.command === 'create')
  if ('error' in parsed || parsed.command !== 'create') return
  assert.deepEqual(unknownServices(parsed.options, ['support']), ['suport'], 'only the wrong ones are reported')

  const wild = parseKeyArgs(['create', '--name', 'x', '--all-services'])
  assert.ok(!('error' in wild) && wild.command === 'create')
  if ('error' in wild || wild.command !== 'create') return
  assert.deepEqual(unknownServices(wild.options, []), [], 'a wildcard key is not checked against concrete service names')
})
