// scripts/fresh-boot-smoke.mjs — Hive plan 2 P6: the fresh-clone journey E2E (always on in CI).
//
// Simulates a brand-new user: temporary directory + minimal config (no spawn → no DSH and no credentials) →
// start from the build output dist/index.js → login (the admin is created automatically) → forced password
// change on first login → the business API is let through → logout. Any failing step exits non-zero.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist', 'index.js')
if (!existsSync(dist)) {
  console.error('dist/index.js does not exist -- run npm run build first.')
  process.exit(1)
}

const PORT = Number(process.env.DAC_BOOT_PORT ?? 18999)
const PASSWORD = 'initial-pass-123'
const NEW_PASSWORD = 'fresh-pass-1234'
const base = `http://127.0.0.1:${PORT}`

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

const work = mkdtempSync(join(tmpdir(), 'dac-fresh-'))
const child = spawn(process.execPath, [dist], {
  cwd: work,
  env: {
    ...process.env,
    SESSION_SECRET: 'fresh-boot-secret-0123456789abcdef0123456789abcdef',
    MANAGER_USERNAME: 'admin',
    MANAGER_INITIAL_PASSWORD: PASSWORD,
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
})

/** Stop the child process and wait for it to really exit (on Windows, deleting a directory with open handles fails with EBUSY). */
const stop = () =>
  new Promise((resolveStop) => {
    if (child.exitCode !== null) {
      resolveStop()
      return
    }
    child.once('exit', () => resolveStop())
    child.kill()
  })

const main = async () => {
  try {
    mkdirSync(join(work, 'workspaces'), { recursive: true })
    writeFileSync(
      join(work, 'manager.config.yaml'),
      [
        'listen:',
        `  host: 127.0.0.1`,
        `  port: ${PORT}`,
        'endpoints:',
        '  A:',
        '    url: http://127.0.0.1:1', // never reachable: E2E needs no real DSH
        '    driver: apiproxy',
        'agents:',
        '  personal:',
        '    name: 个人',
        '    endpoint: A',
        `    workspace: ${join(work, 'workspaces').replace(/\\/g, '/')}`,
        'database:',
        `  path: ${join(work, 'data', 'manager.db').replace(/\\/g, '/')}`,
      ].join('\n'),
      'utf8',
    )

    // wait for /healthz
    let up = false
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`${base}/healthz`)
        if (r.ok) {
          up = true
          break
        }
      } catch {
        // not up yet
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    check('manager boots on a fresh clone', up, up ? '' : `stderr: ${stderr.slice(-300)}`)
    if (!up) return

    // unauthenticated = 401
    check('anonymous /api/status is 401', (await fetch(`${base}/api/status`)).status === 401)

    // login (the admin is created automatically)
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    })
    const loginBody = await json(login)
    check('initial login succeeds', login.status === 200)
    check('mustChangePassword is set on first login', loginBody.mustChangePassword === true)

    const setCookie = login.headers.getSetCookie()
    const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    const csrfLine = setCookie.find((c) => c.startsWith('dac_csrf='))
    const csrf = csrfLine === undefined ? '' : csrfLine.split(';')[0]?.slice('dac_csrf='.length)
    check('CSRF cookie issued', csrf !== '')
    const headers = { cookie, ...(csrf === '' ? {} : { 'x-csrf-token': csrf }) }

    // the business API is 403 while the password change is pending
    const blocked = await fetch(`${base}/api/status`, { headers: { cookie } })
    check('business API blocked until password change', blocked.status === 403)

    // a password change request without a CSRF token is rejected
    const noCsrf = await fetch(`${base}/api/account/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    })
    check('password change without CSRF token is 403', noCsrf.status === 403)

    // change the password
    const changed = await fetch(`${base}/api/account/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    })
    check('forced password change succeeds', changed.status === 200)

    // P1-5: the password change revokes the old session and reissues the current one (the browser picks it up via Set-Cookie)
    const changedCookies = changed.headers.getSetCookie()
    const cookie2 = changedCookies.map((c) => c.split(';')[0]).join('; ')
    const csrf2Line = changedCookies.find((c) => c.startsWith('dac_csrf='))
    const csrf2 = csrf2Line === undefined ? '' : csrf2Line.split(';')[0]?.slice('dac_csrf='.length)
    check('password change reissues the session', cookie2 !== '' && cookie2 !== cookie)
    const staleSession = await fetch(`${base}/api/status`, { headers: { cookie } })
    check('old session is revoked after password change', staleSession.status === 401, `got ${staleSession.status}`)
    const headers2 = { cookie: cookie2, ...(csrf2 === '' ? {} : { 'x-csrf-token': csrf2 }) }

    // the business API is let through + the audit log keeps a trace
    const status = await json(await fetch(`${base}/api/status`, { headers: headers2 }))
    check('business API works after change', (status.agents ?? []).length === 1)
    const audit = await json(await fetch(`${base}/api/audit`, { headers: headers2 }))
    const kinds = (audit.entries ?? []).map((e) => e.kind)
    check('audit trail has login_success and password_change', kinds.includes('login_success') && kinds.includes('password_change'), kinds.join(','))

    // the old password stops working, the new one can log in
    const oldLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    })
    check('old password no longer works', oldLogin.status === 401)

    // logout
    const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: headers2 })
    check('logout succeeds', logout.status === 200)
  } finally {
    await stop()
    rmSync(work, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'fresh-boot smoke: all checks passed' : `${failures} check(s) failed`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
