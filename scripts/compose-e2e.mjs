// scripts/compose-e2e.mjs — 债务 R10:compose 全栈 E2E(CI 门禁)。
//
// 前置(由 .github/workflows/ci.yml 的 compose-e2e job 完成):
//   bash scripts/gen-env.sh(MANAGER_PASSWORD 预置)
//   cp manager.config.container.example.yaml manager.config.yaml
//   cp deploy/nginx/default.conf.example deploy/nginx/default.conf
//   docker compose up -d --build
//
// 本脚本经 nginx(127.0.0.1:80)验证发布门:
//   启动 → 登录(自动建管理员)→ 首登强制改密 → 节点认领(brain 脊柱只读 +
//   personal 工蜂被 manager 认领)→ 动态开通(worker 工蜂)→ 停机 →
//   恢复保护(manager 运行中 restore 必须拒绝)→ 下线(容器被移除)。
// 任何一步失败退出码非 0。
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

/** 登录并把 Set-Cookie 解析成 {cookie, csrf, headers}。 */
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

/** 等待 fetch 条件满足;超时返回 false。 */
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
    check('.env 里有 MANAGER_INITIAL_PASSWORD', false, '先跑 gen-env.sh(MANAGER_PASSWORD 预置)')
    process.exit(1)
  }

  // ---- 启动:nginx 入口可达(经 nginx 转发到 manager)----
  const nginxUp = await waitFor(
    'nginx 入口可达并转发 manager',
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

  // ---- 登录 + 首登强制改密 ----
  const first = await login(PASSWORD)
  check('初始密码登录成功', first.status === 200, `got ${first.status}`)
  check('首登强制改密标记', first.body.mustChangePassword === true)
  if (first.status !== 200) process.exit(1)
  const headers1 = { cookie: first.cookie, 'x-csrf-token': first.csrf }

  const changed = await fetch(`${BASE}/api/account/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers1 },
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  })
  check('首登强制改密成功', changed.status === 200, `got ${changed.status}`)
  const setCookie = changed.headers.getSetCookie()
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  const csrfLine = setCookie.find((c) => c.startsWith('dac_csrf='))
  const csrf = csrfLine === undefined ? '' : (csrfLine.split(';')[0] ?? '').slice('dac_csrf='.length)
  check('改密后换发会话', cookie !== '' && cookie !== first.cookie)
  const headers = { cookie, 'x-csrf-token': csrf }

  // ---- 节点认领:brain(脊柱,只读)+ personal(工蜂,manager 经 docker.sock 认领)----
  const nodesOk = await waitFor(
    '节点列表:brain 与 personal 都在册',
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

  // 脊柱节点 up/down 必须 409(由 compose 管理)
  const brainUp = await fetch(`${BASE}/api/nodes/brain/up`, { method: 'POST', headers })
  check('脊柱主脑 up 被拒(compose 管理)', brainUp.status === 409, `got ${brainUp.status}`)

  // personal 工蜂被 boot 对账认领为 live(镜像已由 compose build 就位)
  const personalLive = await waitFor(
    'personal 工蜂被 boot 对账认领为 live',
    async () => {
      const r = await fetch(`${BASE}/api/nodes`, { headers })
      const body = await json(r)
      const personal = (body.nodes ?? []).find((n) => n.id === 'personal')
      return personal !== undefined && personal.state === 'live'
    },
    120_000,
  )
  if (!personalLive) process.exit(1)

  // ---- 动态开通:worker 工蜂 ----
  const created = await fetch(`${BASE}/api/nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'worker', install: false }),
  })
  check('动态开通 worker 节点 201', created.status === 201, `got ${created.status}: ${String((await json(created)).detail ?? '')}`)
  if (created.status !== 201) process.exit(1)

  const workerLive = await waitFor(
    'worker 工蜂经 docker.sock 拉起为 live',
    async () => {
      const r = await fetch(`${BASE}/api/nodes`, { headers })
      const body = await json(r)
      const worker = (body.nodes ?? []).find((n) => n.id === 'worker')
      return worker !== undefined && worker.state === 'live'
    },
    120_000,
  )
  if (!workerLive) process.exit(1)

  // ---- 停机:worker down → 容器停止并移除 ----
  const down = await fetch(`${BASE}/api/nodes/worker/down`, { method: 'POST', headers })
  check('worker down 200', down.status === 200, `got ${down.status}`)
  const workerCold = await waitFor(
    'worker 停机后落 cold,容器被移除',
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

  // ---- 恢复保护:manager 运行中 restore 必须拒绝(备份先成功,顺带验证加密快照)----
  const backup = docker(['compose', 'exec', '-T', 'manager', 'node', 'dist/cli/backup.js'])
  check('容器内 backup 成功(加密快照)', backup.code === 0, backup.err || backup.out)
  const restore = docker(['compose', 'exec', '-T', 'manager', 'node', 'dist/cli/backup.js', 'restore', 'latest'])
  check(
    'manager 运行中 restore 被拒绝(停机/恢复保护)',
    // 断言用**英文**子串：i18n 迁移（B4，2026-09-24）把 CLI 与服务端 detail 全部英文化了，
    // 这里原来断言中文 `/运行/` → 自 v1.1.1 起 compose-e2e 必红（2026-09-24 定位）。
    // 改断言时请对着 src/cli/backup.ts 的 "still running" 那句一起改。
    restore.code !== 0 && /still running|stop it before restoring/i.test(restore.out + restore.err),
    `code=${restore.code} ${restore.out} ${restore.err}`,
  )

  // ---- 下线:worker 删除(磁盘目录保留,配置与内存清理)----
  const removed = await fetch(`${BASE}/api/nodes/worker`, { method: 'DELETE', headers })
  check('worker 下线 200', removed.status === 200, `got ${removed.status}`)
  const nodesAfter = await json(await fetch(`${BASE}/api/nodes`, { headers }))
  const stillThere = (nodesAfter.nodes ?? []).some((n) => n.id === 'worker')
  check('worker 已从节点列表消失', !stillThere)

  console.log(`\n${failures === 0 ? 'compose E2E: all checks passed' : `${failures} check(s) failed`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
