import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntime, LEGACY_PEER_DEPS_VERSIONS } from './agent/runtime.mjs'

/** In-memory fake file system. */
const fakeFs = () => {
  const store = new Map()
  return {
    store,
    readFile: (p) => store.get(p) ?? null,
    writeFile: (p, c) => store.set(p, c),
    mkdir: () => {},
    exists: (p) => store.has(p),
    stat: (p) => (store.has(p) ? store.get(p).length : null),
    rename: (from, to) => {
      const v = store.get(from)
      if (v === undefined) return
      store.set(to, v)
      store.delete(from)
    },
    remove: (p) => {
      store.delete(p)
    },
    /**
     * Incident regression: directory listing -- the discovery entry point for self-recovery after a restart (the in-memory disk is inferred back from the files already written).
     * Semantics match the real readdirSync: a missing or empty directory -> null.
     */
    listDir: (p) => {
      const prefix = `${p}/`
      const names = new Set()
      for (const path of store.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash > 0) names.add(rest.slice(0, slash))
      }
      return names.size > 0 ? [...names] : null
    },
  }
}

const makeRuntime = (over = {}) => {
  const transport = {
    registerCalls: [],
    register: async (_url, body) => {
      transport.registerCalls.push(body)
      return { agentId: 'agent-test-1', agentToken: 'token-1' }
    },
    commandBatches: [],
    eventsPosted: [],
    commands: async () => {
      const batch = transport.commandBatches.shift() ?? []
      return batch
    },
    events: async (_url, _id, _token, events) => {
      transport.eventsPosted.push(events)
    },
    ...over.transport,
  }
  const proc = {
    installed: [],
    spawned: [],
    killed: [],
    profileInstalls: [],
    /** Incident regression: the live-pid set -- spawn adds, kill removes, faithfully modelling `who is still alive`. */
    alivePids: new Set(),
    install: async (_dir, version, legacy) => {
      proc.installed.push({ version, legacy })
      return `/agent/dsh/${version}/node_modules/@deepseek-ai/dsh/lib/bin.js`
    },
    installProfile: async (dir, legacy) => {
      proc.profileInstalls.push({ dir, legacy })
    },
    spawn: async (bin, args, env) => {
      const pid = 4242 + proc.spawned.length
      proc.spawned.push({ bin, args, env, pid })
      proc.alivePids.add(pid)
      return { pid }
    },
    kill: async (pid) => {
      proc.killed.push(pid)
      proc.alivePids.delete(pid)
    },
    /**
     * Incident regression (2026-09-25 EADDRINUSE): this used to always answer `true` -- a `lazy stub` that,
     * once the idempotence gate shipped, short-circuited every second spawn as `already alive`.
     * Answer with the real semantics: only a pid that was spawned and not killed counts as alive.
     */
    alive: async (pid) => proc.alivePids.has(pid),
    ...over.proc,
  }
  const fs = over.fs ?? fakeFs()
  const backoffs = []
  const runtime = new AgentRuntime({
    managerUrl: 'https://app.example.com',
    joinToken: 'join-1',
    agentDir: '/agent',
    transport,
    proc,
    fs,
    maxWaitMs: 10,
    backoff: async (ms) => {
      backoffs.push(ms)
    },
    log: () => {},
    ...over,
  })
  return { runtime, transport, proc, fs, backoffs }
}

test('Capability four M1-5: registration -- the first exchange mints an identity and writes a 0600 state file; a restart reuses it without re-registering', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  assert.equal(a.runtime.agentId, 'agent-test-1')
  assert.equal(a.transport.registerCalls.length, 1)
  assert.deepEqual(a.transport.registerCalls[0], { joinToken: 'join-1', hostname: a.transport.registerCalls[0].hostname, os: process.platform, arch: process.arch, nodeVersion: process.version })
  assert.ok(a.fs.store.get('/agent/agent.json')?.includes('agent-test-1'), 'identity written to disk')

  const b = makeRuntime({ fs: a.fs })
  await b.runtime.registerOnce()
  assert.equal(b.transport.registerCalls.length, 0, 'an existing identity is not re-registered')
})

test('Capability four M1-6: the spawn command -- derived profile delivery (idempotent file writes + a dependency install with legacy) + fleet.md', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([
    {
      id: 7,
      type: 'node.spawn',
      payload: {
        nodeId: 'ops01',
        args: ['--profile', 'ops01', '--port', '3081', '--no-open'],
        env: { DSH_HOME: '/srv/nodes/ops01', GW_KEY: 'apigw-k' },
        dshVersion: '0.1.5-rc.2',
        profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}', 'cordis.yml': '[]', '.seed-version': 'abc\n' } },
        fleetMd: '# fleet\ncontent',
      },
    },
  ])
  await a.runtime.loopOnce()
  const profileRoot = '/srv/nodes/ops01/profiles/ops01'
  assert.equal(a.fs.store.get(`${profileRoot}/package.json`), '{"dsh":1}', 'profile file written to disk')
  assert.equal(a.fs.store.get(`${profileRoot}/.seed-version`), 'abc\n')
  assert.equal(a.fs.store.get('/srv/nodes/ops01/fleet.md'), '# fleet\ncontent', 'fleet.md lands in DSH_HOME')
  assert.deepEqual(a.proc.profileInstalls[0], { dir: profileRoot, legacy: true }, 'a 0.1.5 profile install carries legacy')
  assert.equal(a.proc.spawned.length, 1, 'spawn only after the install finishes')

  // Idempotent: a repeated spawn with unchanged content rewrites nothing (the install still re-runs idempotently)
  const writes = a.fs.store.size
  a.transport.commandBatches.push([{ id: 8, type: 'node.spawn', payload: { nodeId: 'ops01', args: [], env: { DSH_HOME: '/srv/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}' } } } }])
  await a.runtime.loopOnce()
  assert.equal(a.fs.store.get(`${profileRoot}/package.json`), '{"dsh":1}')
  assert.ok(a.fs.store.size <= writes + 3, 'unchanged content appends no writes (only the new pid and such)')
})

test('Capability four M1-5: the spawn command -- a pinned prefix install (0.1.5 with legacy), the spawn payload, the pidfile, the result report', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([
    { id: 7, type: 'node.spawn', payload: { nodeId: 'ops01', args: ['--profile', 'ops01', '--port', '3081', '--no-open'], env: { DSH_HOME: '/srv/nodes/ops01', GW_KEY: 'apigw-k' }, dshVersion: '0.1.5-rc.2' } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.proc.installed.length, 1)
  assert.deepEqual(a.proc.installed[0], { version: '0.1.5-rc.2', legacy: true }, '0.1.5 requires --legacy-peer-deps')
  const spawned = a.proc.spawned[0]
  assert.equal(spawned.bin.endsWith('/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'), true)
  assert.deepEqual(spawned.args, ['--profile', 'ops01', '--port', '3081', '--no-open'])
  assert.equal(spawned.env.DSH_HOME, '/srv/nodes/ops01')
  assert.ok(a.fs.store.get('/agent/nodes/ops01/node.pid') === '4242', 'pidfile written to disk')
  assert.match(a.fs.store.get('/srv/nodes/ops01/settings.yaml') ?? '', /apigw-k/, 'GW_KEY written into settings')
  const posted = a.transport.eventsPosted.flat()
  assert.deepEqual(posted[0], { type: 'command_result', commandId: 7, ok: true, result: { pid: 4242 } })
})

test('Capability four M1 pilot regression: spawn prefers the profile-local bin (a standalone prefix tree lacks the peer and was measured to crash on start)', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  // Pre-seed the profile-local bin (the shape a profile takes once its idempotently written files are installed)
  a.fs.store.set('/agent/nodes/ops01/profiles/ops01/node_modules/@deepseek-ai/dsh/lib/bin.js', '')
  a.transport.commandBatches.push([
    {
      id: 9,
      type: 'node.spawn',
      payload: {
        nodeId: 'ops01',
        args: ['--profile', 'ops01', '--port', '3081'],
        env: { DSH_HOME: '/agent/nodes/ops01', GW_KEY: 'apigw-k' },
        dshVersion: '0.1.5-rc.2',
        profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}' } },
      },
    },
  ])
  await a.runtime.loopOnce()
  const spawned = a.proc.spawned[0]
  assert.equal(spawned.bin.endsWith('/agent/nodes/ops01/profiles/ops01/node_modules/@deepseek-ai/dsh/lib/bin.js'), true, 'with a profile-local bin the prefix tree is never used')
  assert.equal(a.proc.installed.length, 0, 'the standalone prefix install is skipped (its tree lacks the legacy peer and would crash)')
})

test('Capability four M2 regression: unchanged files + an install-complete marker = skip the npm reinstall (minutes on a slow disk); a half-installed tree with no marker must reinstall', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  const profileDir = '/agent/nodes/ops01/profiles/ops01'
  a.fs.store.set(`${profileDir}/node_modules/@deepseek-ai/dsh/lib/bin.js`, '')
  a.fs.store.set(`${profileDir}/.installed-ok`, '1')
  a.fs.store.set(`${profileDir}/package.json`, '{"dsh":1}')
  a.transport.commandBatches.push([
    { id: 51, type: 'node.spawn', payload: { nodeId: 'ops01', args: ['--profile', 'ops01'], env: { DSH_HOME: '/agent/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}' } } } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.proc.profileInstalls.length, 0, 'unchanged + marker = skip the reinstall')

  // Files changed -> reinstall even with the marker present
  // (Extra premise from the incident regression: a reinstall only happens when the node was really
  //  spawned again, because the idempotence gate blocks a repeat spawn while the process is alive.
  //  This states explicitly that the previous node is dead -- otherwise the test measures the skip.)
  a.proc.alivePids.clear()
  a.transport.commandBatches.push([
    { id: 52, type: 'node.spawn', payload: { nodeId: 'ops01', args: [], env: { DSH_HOME: '/agent/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":2}' } } } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.proc.profileInstalls.length, 1, 'changed content must reinstall')

  // No marker (half-installed or an old version) -> reinstall as the fallback
  const b = makeRuntime()
  await b.runtime.registerOnce()
  b.fs.store.set(`${profileDir}/node_modules/x`, '')
  b.transport.commandBatches.push([
    { id: 53, type: 'node.spawn', payload: { nodeId: 'ops01', args: [], env: { DSH_HOME: '/agent/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{}' } } } },
  ])
  await b.runtime.loopOnce()
  assert.equal(b.proc.profileInstalls.length, 1, 'no completion marker must reinstall')
})

test('Fleet M3 regression: with ALLOW_FULL_ACCESS=true settings.yaml carries the facade allowFullAccess unlock', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([
    { id: 61, type: 'node.spawn', payload: { nodeId: 'ops33', args: [], env: { DSH_HOME: '/agent/nodes/ops33', GW_KEY: 'apigw-k', ALLOW_FULL_ACCESS: 'true' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops33', files: { 'package.json': '{}' } } } },
  ])
  await a.runtime.loopOnce()
  const settings = a.fs.store.get('/agent/nodes/ops33/settings.yaml') ?? ''
  assert.match(settings, /apiKeys: \['apigw-k'\]/, 'GW_KEY is still written')
  assert.match(settings, /allowFullAccess: true/, 'the unlock field is written for an ops node')

  const b = makeRuntime()
  await b.runtime.registerOnce()
  b.transport.commandBatches.push([
    { id: 62, type: 'node.spawn', payload: { nodeId: 'ops34', args: [], env: { DSH_HOME: '/agent/nodes/ops34', GW_KEY: 'apigw-k' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops34', files: { 'package.json': '{}' } } } },
  ])
  await b.runtime.loopOnce()
  const plain = b.fs.store.get('/agent/nodes/ops34/settings.yaml') ?? ''
  assert.ok(!plain.includes('allowFullAccess'), 'an ordinary node is not unlocked')
})

test('0.2.0 corridor: a 0.2.x spawn materializes GW_KEY into the patch config row -- settings.yaml is never written, a rotation does not reinstall', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  // The manager-side baseline for a new-line profile (webserver + the J1-22 privacy row, no facade row)
  const baseline = '- id: webserver\n  config:\n    host: 0.0.0.0\n    port: 3081\n- id: session-log-deepseek\n  config:\n    enabled: false\n'
  const spawnCmd = (id, key, extraEnv = {}) => ({
    id,
    type: 'node.spawn',
    payload: {
      nodeId: 'ops02',
      args: ['--profile', 'ops02'],
      env: { DSH_HOME: '/agent/nodes/ops02', GW_KEY: key, ...extraEnv },
      dshVersion: '0.2.0-rc.2',
      profile: { dir: 'profiles/ops02', files: { 'package.json': '{"dsh":1}', 'cordis.patch.yml': baseline } },
    },
  })
  a.transport.commandBatches.push([spawnCmd(70, 'apigw-020')])
  await a.runtime.loopOnce()
  const profileDir = '/agent/nodes/ops02/profiles/ops02'
  assert.equal(a.fs.store.get('/agent/nodes/ops02/settings.yaml'), undefined, 'the new line never writes settings.yaml (one-shot import + dead facade settings layer, dsh-facts §18.5)')
  const patch = a.fs.store.get(`${profileDir}/cordis.patch.yml`) ?? ''
  assert.ok(patch.startsWith(baseline), 'the delivered baseline is preserved verbatim')
  assert.match(patch, /- id: ohdsh-api-facade\n {2}config:\n {4}apiKeys: \['apigw-020'\]/, 'the facade key row is appended to the patch')
  assert.deepEqual(a.proc.profileInstalls[0], { dir: profileDir, legacy: true }, 'the 0.2.0 profile install carries --legacy-peer-deps')

  // A key rotation rewrites the patch but must NOT trigger the dependency reinstall (the patch
  // carries no dependencies; a reinstall would cost minutes on a slow disk per rotation)
  a.proc.alivePids.clear()
  a.transport.commandBatches.push([spawnCmd(71, 'apigw-rotated')])
  await a.runtime.loopOnce()
  assert.equal(a.proc.profileInstalls.length, 1, 'a rotation triggers no reinstall')
  const rotated = a.fs.store.get(`${profileDir}/cordis.patch.yml`) ?? ''
  assert.match(rotated, /apigw-rotated/, 'the rotated key lands in the patch')
  assert.equal((rotated.match(/ohdsh-api-facade/g) ?? []).length, 1, 'exactly one facade row -- the rewrite from the delivered baseline prevents duplicates')

  // ALLOW_FULL_ACCESS rides into the patch config on the new line (the Fleet M3 parity)
  a.proc.alivePids.clear()
  a.transport.commandBatches.push([spawnCmd(72, 'apigw-rotated', { ALLOW_FULL_ACCESS: 'true' })])
  await a.runtime.loopOnce()
  assert.match(a.fs.store.get(`${profileDir}/cordis.patch.yml`) ?? '', /allowFullAccess: true/, 'the ops-tier unlock lands in the patch config')
})

test('Capability four M4-4: heartbeat metrics -- the first round carries host metrics and does not repeat within the 60s window', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const first = a.transport.eventsPosted.flat().find((e) => e.type === 'heartbeat')
  assert.ok(first !== undefined && typeof first.detail?.metrics === 'object', 'the first heartbeat carries the metrics')
  assert.equal(typeof first.detail.metrics.memTotal, 'number')
  assert.equal(first.detail.metrics.platform, process.platform)

  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const second = (a.transport.eventsPosted[1] ?? []).filter((e) => e.type === 'heartbeat')
  assert.equal(second.length, 0, 'no repeat report inside the 60s window (sampling throttle)')
})

test('Capability four M4-3: agent.update -- a passing sha256 check stages into .next and waits to exit; a bad check is refused', async () => {
  const { createHash } = await import('node:crypto')
  const a = makeRuntime()
  await a.runtime.registerOnce()
  const runtimeContent = 'runtime-v2'
  const entryContent = 'entry-v2'
  const files = { 'runtime.mjs': runtimeContent, 'agent.mjs': entryContent }
  const sha = createHash('sha256').update(Object.keys(files).sort().map((name) => `${name}:${files[name]}`).join('\n')).digest('hex')
  a.transport.commandBatches.push([
    { id: 41, type: 'agent.update', payload: { files, sha256: sha, managerVersion: '9.9.9' } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.fs.store.get('/agent/.next/runtime.mjs'), runtimeContent, '.next staging')
  assert.equal(a.fs.store.get('/agent/.next/.version'), '9.9.9', 'the target version travels with the bundle')
  assert.equal(a.runtime.pendingExit, true, 'it exits after reporting and leaves that to the service manager')
  const posted = a.transport.eventsPosted.flat().find((e) => e.type === 'command_result')
  assert.equal(posted?.ok, true)

  const b = makeRuntime()
  await b.runtime.registerOnce()
  b.transport.commandBatches.push([
    { id: 42, type: 'agent.update', payload: { files: { 'runtime.mjs': 'x', 'agent.mjs': 'y' }, sha256: 'deadbeef', managerVersion: '9.9.9' } },
  ])
  await b.runtime.loopOnce()
  const second = b.transport.eventsPosted.flat().find((e) => e.type === 'command_result')
  assert.equal(second?.ok, false, 'a failed check refuses the swap')
  assert.equal(b.fs.store.get('/agent/.next/runtime.mjs') ?? null, null, 'no staging')
  assert.equal(b.runtime.pendingExit, false, 'no exit')
})

test('Capability four M4-3: version negotiation -- the first heartbeat after start carries agentVersion (from .update-version)', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.fs.store.set('/agent/.update-version', '1.1.2')
  a.runtime.agentVersion = '1.1.2'
  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const heartbeat = a.transport.eventsPosted.flat().find((e) => e.type === 'heartbeat')
  assert.equal(heartbeat?.detail?.agentVersion, '1.1.2', 'the heartbeat carries the version (merged with the metrics into one event)')
})

test('Capability four M4-2: an oversized node.log is rotated before spawn (one generation kept, the new log starts from zero)', async () => {
  const { NODE_LOG_MAX_BYTES } = await import('./agent/runtime.mjs')
  const big = NODE_LOG_MAX_BYTES + 1024
  const a = makeRuntime()
  await a.runtime.registerOnce()
  // Pre-seed the profile-local bin plus an oversized old log
  a.fs.store.set('/agent/nodes/ops01/profiles/ops01/node_modules/@deepseek-ai/dsh/lib/bin.js', '')
  a.fs.store.set('/agent/nodes/ops01/node.log', 'x'.repeat(big))
  a.runtime.nodes.set('ops01', { pid: null, startedAt: null, logOffset: 999 })
  a.transport.commandBatches.push([
    {
      id: 31,
      type: 'node.spawn',
      payload: {
        nodeId: 'ops01',
        args: ['--profile', 'ops01', '--port', '3081'],
        env: { DSH_HOME: '/agent/nodes/ops01', GW_KEY: 'apigw-k' },
        dshVersion: '0.1.5-rc.2',
        profile: { dir: 'profiles/ops01', files: { 'package.json': '{"dsh":1}' } },
      },
    },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.fs.store.get('/agent/nodes/ops01/node.log.1')?.length, big, 'the old log rotates to .1 (one generation kept so crash forensics survive)')
  assert.equal(a.fs.store.get('/agent/nodes/ops01/node.log') ?? null, null, 'the old node.log has stepped aside (a real spawn opens a new file)')
  const node = a.runtime.nodes.get('ops01')
  assert.equal(node?.logOffset, 0, 'the new log generation starts at offset zero')

  // A small log is not rotated
  const b = makeRuntime()
  await b.runtime.registerOnce()
  b.fs.store.set('/agent/nodes/ops01/profiles/ops01/node_modules/@deepseek-ai/dsh/lib/bin.js', '')
  b.fs.store.set('/agent/nodes/ops01/node.log', 'small-boot\n')
  b.transport.commandBatches.push([
    { id: 32, type: 'node.spawn', payload: { nodeId: 'ops01', args: [], env: { DSH_HOME: '/agent/nodes/ops01' }, dshVersion: '0.1.5-rc.2', profile: { dir: 'profiles/ops01', files: { 'package.json': '{}' } } } },
  ])
  await b.runtime.loopOnce()
  assert.equal(b.fs.store.get('/agent/nodes/ops01/node.log'), 'small-boot\n', 'a small log is left as it is')
  assert.equal(b.fs.store.get('/agent/nodes/ops01/node.log.1'), undefined, 'no .1 is produced')
})

test('Capability four M4-1: config.deliver identity rotation -- a new token takes effect as soon as it is written; an unknown kind fails honestly', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.transport.commandBatches.push([
    { id: 21, type: 'config.deliver', payload: { kind: 'identity', agentToken: 'token-rotated-1' } },
  ])
  await a.runtime.loopOnce()
  assert.equal(a.runtime.agentToken, 'token-rotated-1', 'the new token takes effect immediately (later polls authenticate with it)')
  const saved = JSON.parse(a.fs.store.get('/agent/agent.json') ?? '{}')
  assert.equal(saved.agentToken, 'token-rotated-1', 'identity written to disk')
  const posted = a.transport.eventsPosted.flat().find((e) => e.type === 'command_result')
  assert.equal(posted?.ok, true, 'reported successfully')

  a.transport.commandBatches.push([{ id: 22, type: 'config.deliver', payload: { kind: 'nope' } }])
  await a.runtime.loopOnce()
  const second = a.transport.eventsPosted.at(-1)?.find((e) => e.commandId === 22)
  assert.equal(second?.ok, false, 'an unknown kind fails honestly (the manager rolls back on that)')
})

test('Capability four M1-5: stop/restart/logs/status/an unknown command', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.runtime.nodes.set('ops01', { pid: 4242, startedAt: Date.now(), logOffset: 0 })
  a.fs.store.set('/agent/nodes/ops01/node.log', 'line1\nline2\nline3\n')

  a.transport.commandBatches.push([{ id: 1, type: 'node.stop', payload: { nodeId: 'ops01' } }])
  a.transport.commandBatches.push([{ id: 2, type: 'node.restart', payload: { nodeId: 'ops01', args: [], env: {}, dshVersion: '0.1.2-rc.1' } }])
  a.transport.commandBatches.push([{ id: 3, type: 'node.logs', payload: { nodeId: 'ops01' } }])
  a.transport.commandBatches.push([{ id: 4, type: 'node.status' }])
  a.transport.commandBatches.push([{ id: 5, type: 'agent.update', payload: {} }])
  await a.runtime.loopOnce()
  await a.runtime.loopOnce()
  await a.runtime.loopOnce()
  await a.runtime.loopOnce()
  await a.runtime.loopOnce()

  assert.deepEqual(a.proc.killed, [4242], 'stop kills the pid')
  const results = a.transport.eventsPosted.flat().filter((e) => e.type === 'command_result')
  assert.equal(results[0]?.ok, true, 'stop ok')
  assert.equal(results[1]?.ok, true, 'restart ok (stop+spawn)')
  assert.equal((results[2]?.result?.logs ?? '').includes('line3'), true, 'logs reads the tail')
  assert.equal((results[3]?.result?.nodes ?? []).length >= 1, true, 'status lists the nodes')
  assert.equal(results[4]?.ok, false, 'an unknown command fails honestly')
})

test('Capability four M1-5: log chunks are shipped incrementally; a lost link backs off exponentially; 401 clears the identity and re-registers; AbortSignal exits cleanly', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  a.runtime.nodes.set('ops01', { pid: 4242, startedAt: Date.now(), logOffset: 0 })
  a.fs.store.set('/agent/nodes/ops01/node.log', 'boot\n')
  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const chunked = a.transport.eventsPosted.flat().find((e) => e.type === 'log_chunk')
  assert.equal(chunked?.chunk, 'boot\n', 'the first round sends the whole delta')

  a.fs.store.set('/agent/nodes/ops01/node.log', 'boot\ndsh web: http://127.0.0.1:3081\n')
  a.transport.commandBatches.push([])
  await a.runtime.loopOnce()
  const chunked2 = a.transport.eventsPosted[1].find((e) => e.type === 'log_chunk')
  assert.equal(chunked2?.chunk, 'dsh web: http://127.0.0.1:3081\n', 'only the delta is shipped')

  // Lost-link backoff + AbortSignal exit
  const b = makeRuntime()
  let calls = 0
  b.transport.commands = async () => {
    calls += 1
    throw new Error('network down')
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  await b.runtime.run({ signal: controller.signal })
  assert.ok(b.backoffs.length >= 1, 'a failure went through the backoff')
  assert.ok(b.backoffs[0] >= 1_000, `first backoff ≥1s (actual ${b.backoffs[0]})`)

  // 401 -> clear the identity -> re-register (a revocation is observable as another registration)
  const c = makeRuntime()
  c.transport.commands = async () => {
    throw new Error('unauthorized')
  }
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 80)
  await c.runtime.run({ signal: ctrl.signal })
  assert.ok(c.transport.registerCalls.length >= 2, 'it re-registers after a 401')
})

test('Capability four M1-5: LEGACY_PEER_DEPS_VERSIONS covers 0.1.5 (aligned with the matrix needsLegacyPeerDeps)', () => {
  assert.ok(LEGACY_PEER_DEPS_VERSIONS.includes('0.1.5-rc.2'))
  assert.ok(!LEGACY_PEER_DEPS_VERSIONS.includes('0.1.2-rc.1'))
})

test('Capability four M1 pilot regression: an npm call must use shell:true and pass the path through cwd (measured: the Windows .cmd shim gives ENOENT)', async () => {
  const { execFileSync } = await import('node:child_process')
  const { npmInvocation } = await import('./agent/runtime.mjs')
  const inv = npmInvocation(['install', 'x@1.0.0', '--no-audit', '--no-fund'], 'C:\\dir with space\\p')
  assert.equal(inv.options.shell, true, 'on Windows npm is a .cmd shim, so shell:true is required to let the system shell resolve it (node>=20 without a shell gives ENOENT/EINVAL)')
  assert.equal(inv.options.cwd, 'C:\\dir with space\\p', 'the install directory travels through cwd only -- a path argument gets split when the shell joins it')
  assert.ok(!inv.args.some((a) => a.includes('dir with space')), 'the path must not appear among the arguments')
  if (process.platform === 'win32') {
    const out = execFileSync('npm', ['--version'], { shell: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
    assert.match(out.trim(), /^\d+\.\d+\.\d+/, 'the real npm resolves through the shell (the old execFileSync(\'npm\') with no shell = ENOENT)')
  }
})

test('Capability four M1 pilot regression: on Windows spawning bin.js must go through node (measured: CreateProcess EFTYPE)', async () => {
  const { spawnInvocation } = await import('./agent/runtime.mjs')
  const win = spawnInvocation('win32', 'C:\\agent\\dsh\\0.1.5-rc.2\\bin.js', ['--profile', 'pilot01', '--port', '3197'])
  assert.equal(win.cmd, process.execPath, 'win32: a .js file has no shebang, so spawning it directly is EFTYPE -- the command must be node')
  assert.deepEqual(win.args, ['C:\\agent\\dsh\\0.1.5-rc.2\\bin.js', '--profile', 'pilot01', '--port', '3197'], 'the bin becomes the first argument')
  const posix = spawnInvocation('linux', '/agent/dsh/0.1.5-rc.2/bin.js', ['--profile', 'pilot01'])
  assert.equal(posix.cmd, '/agent/dsh/0.1.5-rc.2/bin.js', 'posix: the shebang allows a direct spawn')
  assert.deepEqual(posix.args, ['--profile', 'pilot01'])
})

// ---- Incident regression (2026-09-25, ubuntu-focal lost contact) ----
//
// What happened: after a host restart two nodes never came back (the manager sweeps every 10 minutes
// by default and the agent side is entirely passive); the `EADDRINUSE 0.0.0.0:3197` in node.log was
// the product of a duplicate spawn -- every reconcile round re-sent node.spawn and the agent pulled
// up another one each time. The two fixes below: idempotent execSpawn, and self-recovery at startup.

/** One node.spawn command (the payload shape is identical to the manager-side supervisor.startAgent). */
const spawnCmd = (id, nodeId, files = { 'package.json': '{"dsh":1}' }) => ({
  id,
  type: 'node.spawn',
  payload: {
    nodeId,
    args: ['--profile', nodeId, '--port', '3197', '--no-open'],
    env: { DSH_HOME: `/agent/nodes/${nodeId}`, GW_KEY: 'apigw-k' },
    dshVersion: '0.1.5-rc.2',
    profile: { dir: `profiles/${nodeId}`, files },
  },
})

test('Incident regression: execSpawn is idempotent -- an already-live node is reused, never a second one fighting for the same port', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()

  const first = await a.runtime.execSpawn(spawnCmd(1, 'spike02'))
  assert.equal(first.ok, true)
  assert.equal(a.proc.spawned.length, 1, 'the first call really does start it')

  // The manager's next reconcile queues the same node.spawn again -- exactly the EADDRINUSE scene
  const second = await a.runtime.execSpawn(spawnCmd(2, 'spike02'))
  assert.equal(second.ok, true)
  assert.equal(second.result.pid, first.result.pid, 'reuses the existing pid')
  assert.equal(second.result.alreadyRunning, true, 'the result says it was a reuse')
  assert.equal(a.proc.spawned.length, 1, 'never a second spawn')
})

test('Incident regression: idempotence must not turn into never restarting -- a dead process still gets pulled up', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()

  const first = await a.runtime.execSpawn(spawnCmd(1, 'spike02'))
  // The process crashed (the pid file is still there -- that is what the scene looked like)
  a.proc.alivePids.delete(first.result.pid)
  assert.equal(a.fs.store.get('/agent/nodes/spike02/node.pid'), String(first.result.pid), 'the pid file is still there')

  const again = await a.runtime.execSpawn(spawnCmd(2, 'spike02'))
  assert.equal(again.ok, true)
  assert.notEqual(again.result.pid, first.result.pid, 'a new process must be started')
  assert.equal(a.proc.spawned.length, 2, 'a dead process does not block the restart')
})

test('Incident regression: idempotence is per node -- one live node does not stop another from starting', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  await a.runtime.execSpawn(spawnCmd(1, 'spike02'))
  await a.runtime.execSpawn(spawnCmd(2, 'ops33'))
  assert.equal(a.proc.spawned.length, 2, 'each node gets its own process')
  await a.runtime.execSpawn(spawnCmd(3, 'spike02'))
  await a.runtime.execSpawn(spawnCmd(4, 'ops33'))
  assert.equal(a.proc.spawned.length, 2, 'another round for each still adds nothing')
})

/**
 * Simulate a host restart: every process is gone (the live-pid set is cleared) and the agent's in-memory
 * node table is cleared, but the disk is still that same disk. This is more faithful than `build another
 * runtime sharing the fs` -- the latter puts the observing proc stub and the object the runtime actually
 * uses out of sync, so what gets measured is not real behaviour.
 */
const simulateRestart = (h) => {
  h.runtime.nodes.clear()
  h.proc.alivePids.clear()
}

test('Incident regression: resumeNodes self-recovers from the on-disk payload (after a host restart it does not wait for the manager)', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  await a.runtime.execSpawn(spawnCmd(1, 'spike02'))
  await a.runtime.execSpawn(spawnCmd(2, 'ops33'))
  assert.equal(a.proc.spawned.length, 2)

  simulateRestart(a)
  assert.equal(a.runtime.nodes.size, 0, 'the in-memory node table is cleared = a brand-new agent')

  const resumed = await a.runtime.resumeNodes()
  assert.deepEqual(resumed.sort(), ['ops33', 'spike02'], 'both nodes recover from disk')
  assert.equal(a.proc.spawned.length, 4, 'after the restart both nodes return to running without the manager sending anything')
})

test('Incident regression: resumeNodes does not resurrect a node stopped by node.stop', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  await a.runtime.execSpawn(spawnCmd(1, 'spike02'))
  await a.runtime.execSpawn(spawnCmd(2, 'ops33'))
  await a.runtime.execStop({ payload: { nodeId: 'spike02' } })
  assert.equal(a.fs.store.has('/agent/nodes/spike02/spawn.json'), false, 'stop deletes the on-disk payload = the intent to stay down')

  simulateRestart(a)
  const before = a.proc.spawned.length
  const resumed = await a.runtime.resumeNodes()
  assert.deepEqual(resumed, ['ops33'], 'only a node still running self-recovers')
  assert.equal(a.proc.spawned.length, before + 1, 'only ops33 is pulled back')
  assert.equal(a.proc.killed.filter((p) => p !== undefined).length >= 1, true, 'stop really did kill a process')
})

test('Incident regression: resumeNodes is a no-op for a node that never started (a brand-new machine)', async () => {
  const a = makeRuntime()
  const resumed = await a.runtime.resumeNodes()
  assert.deepEqual(resumed, [])
  assert.equal(a.proc.spawned.length, 0, 'with no on-disk state it does nothing')
})

test('Incident regression: resumeNodes tolerates a bad payload -- one bad file does not drag down the other nodes', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  await a.runtime.execSpawn(spawnCmd(1, 'spike02'))
  await a.runtime.execSpawn(spawnCmd(2, 'ops33'))
  a.fs.store.set('/agent/nodes/spike02/spawn.json', '{ not json')

  simulateRestart(a)
  const before = a.proc.spawned.length
  const resumed = await a.runtime.resumeNodes()
  assert.deepEqual(resumed, ['ops33'], 'a bad payload only loses itself')
  assert.equal(a.proc.spawned.length, before + 1, 'the other node still recovers')
})

test('Incident regression: the nodeId in a payload must match its directory -- a tampered file must not write elsewhere', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  await a.runtime.execSpawn(spawnCmd(1, 'spike02'))
  // Point the payload's nodeId at another node: the input to path joining is untrusted
  const payload = JSON.parse(a.fs.store.get('/agent/nodes/spike02/spawn.json'))
  payload.nodeId = '../../etc'
  a.fs.store.set('/agent/nodes/spike02/spawn.json', JSON.stringify(payload))

  simulateRestart(a)
  const resumed = await a.runtime.resumeNodes()
  assert.deepEqual(resumed, [], 'a directory that disagrees with the payload = self-recovery refused')
  assert.equal(a.proc.spawned.length, 1, 'never start a process under a tampered nodeId')
})

test('Incident regression: run() self-recovers before registering -- the nodes come up even when the manager is unreachable', async () => {
  const a = makeRuntime()
  await a.runtime.registerOnce()
  await a.runtime.execSpawn(spawnCmd(1, 'spike02'))

  // The same agent reports back for work, but the manager is completely unreachable (registration must fail)
  simulateRestart(a)
  a.fs.store.delete('/agent/agent.json')
  const before = a.proc.spawned.length
  a.transport.register = async () => {
    throw new Error('manager unreachable')
  }
  // run() backs off and retries forever on a network failure (by design), so a signal ends it;
  // the point is that the nodes must already be back before registration fails.
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 30)
  await a.runtime.run({ signal: ctrl.signal })
  assert.equal(a.proc.spawned.length, before + 1, 'self-recovery does not depend on the manager being reachable')
})


