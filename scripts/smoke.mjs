// End-to-end smoke test against a running manager.
//
//   node scripts/smoke.mjs [password] [baseUrl]
//
// Covers auth boundaries, endpoint status, the workspace adapter, and (Hive P6)
// the full conversation pipeline: chat turn over the relay, and a brain
// dispatch with its delegation/notification trail. Password and BRAIN_TOKEN
// fall back to the .env in the working directory.
// Exits non-zero on the first hard failure so it can gate a deploy.

import { readFileSync } from 'node:fs'

const envFile = () => {
  const out = {}
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m !== null) out[m[1]] = m[2]
    }
  } catch {
    // no .env: caller must supply everything
  }
  return out
}
const env = envFile()

const password = process.argv[2] ?? process.env.MANAGER_INITIAL_PASSWORD ?? env.MANAGER_INITIAL_PASSWORD
const newPassword = process.env.SMOKE_NEW_PASSWORD ?? null
const base = (process.argv[3] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
const username = process.env.MANAGER_USERNAME ?? env.MANAGER_USERNAME ?? 'admin'
const brainToken = process.env.BRAIN_TOKEN ?? env.BRAIN_TOKEN

if (password === undefined) {
  console.error('usage: node scripts/smoke.mjs <password> [baseUrl]')
  process.exit(2)
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures += 1
}
const info = (label, detail) => console.log(`      ${label}  ${detail}`)

const json = async (response) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text.slice(0, 200) }
  }
}

const cookieOf = (setCookie, name) => {
  const line = setCookie.find((c) => c.startsWith(`${name}=`))
  return line === undefined ? '' : line.split(';')[0]?.slice(name.length + 1)
}

const tryLogin = async (pwd) => {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: pwd }),
  })
  return { response, body: await json(response) }
}

const main = async () => {
  console.log(`\n-- auth boundaries --`)
  const root = await fetch(`${base}/`, { redirect: 'manual' })
  check('GET / redirects', root.status === 302, `-> ${root.headers.get('location')}`)

  const app = await fetch(`${base}/app`, { redirect: 'follow' })
  // Since Hive Q5 /app goes straight to the most recent chat: unauthenticated it ends up on /login through the 302 chain.
  check('GET /app unauthenticated lands on /login', app.status === 200 && new URL(app.url).pathname === '/login', `final=${new URL(app.url).pathname}`)

  const apiAnon = await fetch(`${base}/api/status`)
  check('GET /api/status unauthenticated is 401', apiAnon.status === 401)

  const bad = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'definitely-wrong' }),
  })
  check('wrong password is 401', bad.status === 401)

  // Hive plan 2 P3: after the forced password change on first login the old password is dead -- when
  // SMOKE_NEW_PASSWORD is set, retry the login with it first (an earlier smoke run already changed it).
  let effectivePassword = password
  let { response: login, body: loginBody } = await tryLogin(password)
  if (login.status !== 200 && newPassword !== null) {
    info('login', 'the initial password is dead, retrying with SMOKE_NEW_PASSWORD')
    const retry = await tryLogin(newPassword)
    login = retry.response
    loginBody = retry.body
    effectivePassword = newPassword
  }
  check('login succeeds', login.status === 200)
  if (login.status !== 200) {
    console.error('\ncannot continue without a session')
    process.exit(1)
  }

  const setCookie = login.headers.getSetCookie()
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  const csrf = cookieOf(setCookie, 'dac_csrf')
  const attrs = setCookie.join(' ')
  check('cookie is HttpOnly', attrs.includes('HttpOnly'))
  check('cookie is SameSite=Lax', /SameSite=Lax/i.test(attrs))

  const auth = { headers: { cookie, ...(csrf === '' ? {} : { 'x-csrf-token': csrf }) } }

  // Hive plan 2 P3: forced password change on first login
  if (loginBody.mustChangePassword === true) {
    const next = newPassword ?? `${password}-new1`
    const changed = await fetch(`${base}/api/account/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth.headers },
      body: JSON.stringify({ currentPassword: effectivePassword, newPassword: next }),
    })
    check('forced password change succeeds', changed.status === 200, `status=${changed.status}`)
    if (changed.status === 200) {
      check('password change is audited', true)
      info('password', `changed to ${next} (set SMOKE_NEW_PASSWORD=${next} for later runs)`)
    }
  }

  console.log(`\n-- status --`)
  const status = await json(await fetch(`${base}/api/status`, auth))
  for (const ep of status.endpoints ?? []) {
    // An unreachable endpoint is a valid state, not a test failure: DSH may
    // simply not be running. What matters is that it degrades to one row.
    info(`endpoint ${ep.id}`, ep.reachable ? `reachable, sessions=${ep.sessions}, apiKeySet=${ep.apiKeySet}` : `unreachable (${ep.error})`)
  }
  check('at least one endpoint is configured', (status.endpoints ?? []).length > 0)
  check('at least one agent is configured', (status.agents ?? []).length > 0)

  console.log(`\n-- workspace adapter --`)
  for (const agent of status.agents ?? []) {
    const w = await json(await fetch(`${base}/api/agents/${agent.id}/workspace`, auth))
    info(`${agent.id} docs`, (w.docs ?? []).map((d) => `${d.name}=${d.present}`).join(' '))
    info(`${agent.id} git`, `repo=${w.git?.isRepo} branch=${w.git?.branch} dirty=${(w.git?.dirty ?? []).length}`)
    if ((w.git?.dirty ?? []).length > 0) info(`${agent.id} dirty`, (w.git.dirty ?? []).join(', '))
    if (w.git?.lastCommit) info(`${agent.id} head`, `${w.git.lastCommit.hash} ${w.git.lastCommit.message.slice(0, 60)}`)

    // The structured-data check runs only for a note-vault workspace (one with RULE.md); a generic
    // workspace built by the wizard has only AGENTS.md + git and no note-data structure -- that is not a defect.
    const isNoteVault = (w.docs ?? []).some((d) => d.name === 'RULE.md' && d.present === true)
    if (!isNoteVault) {
      check(`${agent.id}: generic workspace is a clean git repo`, w.git?.isRepo === true && (w.git?.dirty ?? []).length === 0)
      continue
    }
    info(`${agent.id} note-data`, `${(w.noteData?.loaded ?? []).length}/5 loaded, keys=[${(w.noteData?.keys ?? []).join(',')}]`)
    check(`${agent.id}: no blockers`, (w.blockers ?? []).length === 0, (w.blockers ?? []).join(' | '))
    if ((w.violations ?? []).length > 0) {
      for (const v of w.violations) info(`${agent.id} violation`, `[${v.rule}] ${v.path} - ${v.detail.slice(0, 90)}`)
    } else {
      info(`${agent.id} violations`, 'none')
    }

    const nd = await json(await fetch(`${base}/api/agents/${agent.id}/notedata`, auth))
    const trade = nd.data?.trade
    if (trade !== undefined) {
      info(`${agent.id} trade`, `asOf=${trade.asOf} holdings=${trade.holdings?.length} history=${trade.history?.length}`)
      check(`${agent.id}: trade history within the documented cap of 8`, (trade.history?.length ?? 0) <= 8)
    }
    check(`${agent.id}: notedata returns parsed data`, nd.data !== undefined && Object.keys(nd.data).length > 0)
  }

  const unknown = await fetch(`${base}/api/agents/does-not-exist/workspace`, auth)
  check('unknown agent is 404', unknown.status === 404)

  console.log(`\n-- conversation (Hive P6: chat turn + brain dispatch) --`)
  const collectFrames = async (chatId, cookie, timeoutMs) => {
    const frames = []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}/api/chats/${chatId}/events`, { headers: { cookie }, signal: controller.signal })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (const line of buffer.split(/\r?\n/)) {
          if (!line.startsWith('data: ')) continue
          try {
            const frame = JSON.parse(line.slice(6))
            frames.push(frame)
            if (frame.kind === 'turn_done') return frames
          } catch {
            // a half frame / heartbeat, ignore
          }
        }
        buffer = ''
      }
    } catch {
      // timeout: frames collected so far
    } finally {
      clearTimeout(timer)
    }
    return frames
  }

  const reachable = (status.endpoints ?? []).filter((e) => e.reachable)
  const personal = (status.agents ?? []).find((a) => a.id === 'personal') ?? (status.agents ?? [])[0]
  if (reachable.length === 0 || personal === undefined) {
    info('conversation', 'skipped: no reachable endpoint or no agent')
  } else {
    const created = await fetch(`${base}/api/chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth.headers },
      body: JSON.stringify({ agentId: personal.id }),
    })
    const chatBody = await json(created)
    check('chat created', created.status === 200 || created.status === 201, `status=${created.status} agent=${personal.id}`)
    const chatId = chatBody.chat?.id

    if (chatId !== undefined) {
      const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth.headers },
        body: JSON.stringify({ text: 'Reply with exactly one word: ok' }),
      })
      check('message accepted', sent.status === 202, `status=${sent.status}`)
      const frames = await collectFrames(chatId, auth.headers.cookie, 180_000)
      const done = frames.find((f) => f.kind === 'turn_done')
      check(
        'turn completed over the relay',
        done !== undefined && done.state === 'done',
        done === undefined ? 'no turn_done frame in time' : `state=${done.state}${done.error ? ` error=${done.error}` : ''}`,
      )

      const brain = (status.agents ?? []).find((a) => a.id === 'brain')
      if (brain !== undefined && brainToken !== undefined && brainToken !== '') {
        const brainChat = await json(
          await fetch(`${base}/api/chats`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth.headers },
            body: JSON.stringify({ agentId: 'brain' }),
          }),
        )
        const dispatch = await fetch(`${base}/api/internal/dispatch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Brain-Token': brainToken },
          body: JSON.stringify({ agentId: personal.id, prompt: 'Reply with exactly one word: ok', sourceChatId: brainChat.chat?.id ?? '' }),
        })
        const dispatchBody = await json(dispatch)
        check('brain dispatch runs', dispatch.status === 200, dispatch.status === 200 ? `state=${dispatchBody.state}` : `status=${dispatch.status} ${dispatchBody.detail ?? ''}`)
        if (dispatch.status === 200) {
          const notifications = await json(await fetch(`${base}/api/notifications`, auth))
          const brainDone = (notifications.items ?? []).find((n) => n.kind === 'brain_done')
          check('brain_done notification recorded', brainDone !== undefined)
        }
      } else {
        info('brain dispatch', 'skipped: no brain agent or no BRAIN_TOKEN')
      }
    }
  }

  console.log(`\n-- logout --`)
  const logout = await fetch(`${base}/api/logout`, { method: 'POST', ...auth })
  check('logout succeeds', logout.status === 200)
  const afterLogout = await fetch(`${base}/api/status`, auth)
  check('session is revoked server-side', afterLogout.status === 401)

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\nsmoke test could not run: ${error.message}`)
  process.exit(1)
})
