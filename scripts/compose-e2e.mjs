// scripts/compose-e2e.mjs — Debt R10: full-stack compose E2E (a CI gate).
//
// Prerequisites (done by the compose-e2e job in .github/workflows/ci.yml):
//   bash scripts/gen-env.sh (MANAGER_PASSWORD pre-set)
//   cp manager.config.container.example.yaml manager.config.yaml
//   cp deploy/nginx/default.conf.example deploy/nginx/default.conf
//   docker compose up -d --build
//
// This script verifies the release gate through nginx (127.0.0.1:80):
//   start → login (the admin is created automatically) → forced password change on first login →
//   node claiming (the brain spine is read-only + the personal worker is claimed by the manager) →
//   dynamic provisioning (a worker) → stop → restore protection (a restore must be refused while the
//   manager runs) → decommission (the container is removed).
// Any failing step exits non-zero.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASE = process.env.DAC_E2E_BASE ?? 'http://127.0.0.1'
const USERNAME = process.env.DAC_E2E_USER ?? 'admin'
const NEW_PASSWORD = 'compose-e2e-pass-1234'

const env = readFileSync('.env', 'utf8')
const envOf = (key) => {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(env)
  const value = match === null ? '' : (match[1] ?? '')
  return value.trim()
}
const PASSWORD = envOf('MANAGER_INITIAL_PASSWORD')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures += 1
}

const json = async (response) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text.slice(0, 200) }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Log in and parse Set-Cookie into {cookie, csrf, headers}. */
const login = async (password) => {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password }),
  })
  const setCookie = response.headers.getSetCookie()
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  const csrfLine = setCookie.find((c) => c.startsWith('dac_csrf='))
  const csrf = csrfLine === undefined ? '' : (csrfLine.split(';')[0] ?? '').slice('dac_csrf='.length)
  return { status: response.status, body: await json(response), cookie, csrf }
}

/** Wait until the fetch condition holds; on timeout return false. */
const waitFor = async (label, predicate, timeoutMs, intervalMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) {
      check(label, false, `timeout after ${timeoutMs}ms`)
      return false
    }
    await sleep(intervalMs)
  }
}

const docker = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

const main = async () => {
  if (PASSWORD === '') {
    check('.env has MANAGER_INITIAL_PASSWORD', false, 'run gen-env.sh first (MANAGER_PASSWORD pre-set)')
    process.exit(1)
  }

  // ---- start: the nginx entry point is reachable (proxying through to the manager) ----
  const nginxUp = await waitFor(
    'nginx entry point reachable and proxying to the manager',
    async () => {
      try {
        const r = await fetch(`${BASE}/login`)
        return r.status === 200
      } catch {
        return false
      }
    },
    180_000,
  )
  if (!nginxUp) process.exit(1)

  // ---- login + forced password change on first login ----
  const first = await login(PASSWORD)
  check('login with the initial password succeeds', first.status === 200, `got ${first.status}`)
  check('forced password change flag on first login', first.body.mustChangePassword === true)
  if (first.status !== 200) process.exit(1)
  const headers1 = { cookie: first.cookie, 'x-csrf-token': first.csrf }

  const changed = await fetch(`${BASE}/api/account/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers1 },
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  })
  check('forced password change on first login succeeds', changed.status === 200, `got ${changed.status}`)
  const setCookie = changed.headers.getSetCookie()
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  const csrfLine = setCookie.find((c) => c.startsWith('dac_csrf='))
  const csrf = csrfLine === undefined ? '' : (csrfLine.split(';')[0] ?? '').slice('dac_csrf='.length)
  check('the session is reissued after the password change', cookie !== '' && cookie !== first.cookie)
  const headers = { cookie, 'x-csrf-token': csrf }

  // ---- node claiming: brain (the spine, read-only) + personal (a worker, claimed by the manager over docker.sock) ----
  const nodesOk = await waitFor(
    'node list: both brain and personal are registered',
    async () => {
      const r = await fetch(`${BASE}/api/nodes`, { headers })
      if (r.status !== 200) return false
      const body = await json(r)
      const ids = (body.nodes ?? []).map((n) => n.id)
      return ids.includes('brain') && ids.includes('personal')
    },
    90_000,
  )
  if (!nodesOk) process.exit(1)

  // brain up/down on the spine node must be 409 (managed by compose)
  const brainUp = await fetch(`${BASE}/api/nodes/brain/up`, { method: 'POST', headers })
  check('up on the brain spine is refused (managed by compose)', brainUp.status === 409, `got ${brainUp.status}`)

  // the personal worker is claimed as live by the boot reconcile (the image is already in place from compose build)
  const personalLive = await waitFor(
    'the personal worker is claimed as live by the boot reconcile',
    async () => {
      const r = await fetch(`${BASE}/api/nodes`, { headers })
      const body = await json(r)
      const personal = (body.nodes ?? []).find((n) => n.id === 'personal')
      return personal !== undefined && personal.state === 'live'
    },
    120_000,
  )
  if (!personalLive) process.exit(1)

  // ---- dynamic provisioning: a worker ----
  const created = await fetch(`${BASE}/api/nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'worker', install: false }),
  })
  check('dynamic provisioning of the worker node returns 201', created.status === 201, `got ${created.status}: ${String((await json(created)).detail ?? '')}`)
  if (created.status !== 201) process.exit(1)

  const workerLive = await waitFor(
    'the worker comes up live over docker.sock',
    async () => {
      const r = await fetch(`${BASE}/api/nodes`, { headers })
      const body = await json(r)
      const worker = (body.nodes ?? []).find((n) => n.id === 'worker')
      return worker !== undefined && worker.state === 'live'
    },
    120_000,
  )
  if (!workerLive) process.exit(1)

  // ---- stop: worker down → the container is stopped and removed ----
  const down = await fetch(`${BASE}/api/nodes/worker/down`, { method: 'POST', headers })
  check('worker down 200', down.status === 200, `got ${down.status}`)
  const workerCold = await waitFor(
    'the worker lands cold after the stop, the container is removed',
    async () => {
      const r = await fetch(`${BASE}/api/nodes`, { headers })
      const body = await json(r)
      const worker = (body.nodes ?? []).find((n) => n.id === 'worker')
      const container = docker(['ps', '-q', '--filter', 'label=com.dac.node=worker'])
      return worker !== undefined && worker.state === 'cold' && container.out === ''
    },
    60_000,
  )
  if (!workerCold) process.exit(1)

  // ---- restore protection: a restore must be refused while the manager runs (the backup succeeds first, verifying the encrypted snapshot on the way) ----
  const backup = docker(['compose', 'exec', '-T', 'manager', 'node', 'dist/cli/backup.js'])
  check('backup inside the container succeeds (encrypted snapshot)', backup.code === 0, backup.err || backup.out)
  const restore = docker(['compose', 'exec', '-T', 'manager', 'node', 'dist/cli/backup.js', 'restore', 'latest'])
  check(
    'a restore is refused while the manager runs (stop/restore protection)',
    // The assertion uses an **English** substring: the i18n migration (B4, 2026-09-24) made every CLI and
    // server-side detail English, so the Chinese `/运行/` this used to assert on made compose-e2e red from
    // v1.1.1 on (pinned down on 2026-09-24).
    // When changing the assertion, change it together with the "still running" line in src/cli/backup.ts.
    restore.code !== 0 && /still running|stop it before restoring/i.test(restore.out + restore.err),
    `code=${restore.code} ${restore.out} ${restore.err}`,
  )

  // ---- decommission: delete the worker (the on-disk directory is kept, config and memory are cleaned) ----
  const removed = await fetch(`${BASE}/api/nodes/worker`, { method: 'DELETE', headers })
  check('worker decommission returns 200', removed.status === 200, `got ${removed.status}`)
  const nodesAfter = await json(await fetch(`${BASE}/api/nodes`, { headers }))
  const stillThere = (nodesAfter.nodes ?? []).some((n) => n.id === 'worker')
  check('the worker is gone from the node list', !stillThere)

  console.log(`\n${failures === 0 ? 'compose E2E: all checks passed' : `${failures} check(s) failed`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
