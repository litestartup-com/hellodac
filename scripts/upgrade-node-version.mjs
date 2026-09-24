/**
 * 能力二（2026-09-20）：节点 DSH 版本升级脚本（幂等，--dry-run 可预演）。
 * upgrade-012-win.mjs 的参数化泛化——目标版本来自版本矩阵 src/dsh-matrix.ts；
 * 脚本独立运行不依赖 ts 源码/构建产物，钉版由 scripts/check-docs.mjs 常驻
 * 断言与矩阵一致（禁止多点手改）。
 *
 * 对 manager.config.yaml 里每个 process 托管节点：
 * 1. profile 依赖/bundles 钉目标版本 + GATEWAY_REF，清 node_modules 后
 *    npm install（矩阵标 needsLegacyPeerDeps 的配对追加 --legacy-peer-deps，
 *    事实卡 dsh-facts §12）；
 * 2. settings.yaml：'ohdsh-api-facade' 命名空间铸/复用 apiKeys（旧 dsh-api-gw
 *    段不动）；
 * 3. 全局 DSH：bin.js 所在 prefix 目录 npm install @deepseek-ai/dsh@<target>
 *    （版本已对则跳过；隔离安装的新节点无此项）；
 * 4. .env：DSH_NODE_IMAGE → hellodac/dac-node:<target>（容器部署换镜像 tag），
 *    GW_KEY_* 同步写回新钥匙（process 节点）。
 *
 * 不碰 manager.config.yaml 的接线形态（归 upgrade-012.mjs）；节点 spawn 钉版
 * 改 manager.config.yaml 由用户在节点页/向导操作，本脚本只改派生面。
 * 用法：node scripts/upgrade-node-version.mjs <target-version> [config路径] [--dry-run] [--force]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'

const require = createRequire(import.meta.url)
const { parse: parseYaml, stringify: stringifyYaml } = require('yaml')
// 与 src/dsh-matrix.ts 保持一致（check-docs.mjs 常驻断言，改矩阵后本表漏改 = CI 红）。
const COMPAT_DSH_PACKAGE = '@deepseek-ai/dsh'
const GATEWAY_PACKAGE = 'ohdsh-api-facade'
const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#b592b4f'
const SUPPORTED = [
  { dsh: '0.1.2-rc.1', legacyPeerDeps: false },
  { dsh: '0.1.5-rc.2', legacyPeerDeps: true },
]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const positional = args.filter((a) => !a.startsWith('--'))
const target = positional[0]
const configPath = positional[1] ?? 'manager.config.yaml'

if (target === undefined) {
  console.error(`upgrade-node-version: 缺少目标版本。支持：${SUPPORTED.map((p) => p.dsh).join(' / ')}`)
  process.exit(1)
}
const pair = SUPPORTED.find((p) => p.dsh === target.replace(/^v/, ''))
if (pair === undefined) {
  console.error(`upgrade-node-version: 目标版本 ${target} 不在版本矩阵里（支持：${SUPPORTED.map((p) => p.dsh).join(' / ')}）——先升级矩阵并重新验证再升级节点`)
  process.exit(1)
}
const TARGET = pair.dsh
const bakSuffix = `.pre-${TARGET}.bak`

// 预检：生产端口被占 = 栈还在跑，npm 清旧文件必 EPERM（2026-09-10 实测炸过
// 一半留半毁树）。要求先停栈，--force 跳过。
const BUSY_PORTS = [8080, 3081, 3082, 3090]
const portBusy = (p) => new Promise((resolveBusy) => {
  const probe = createServer()
  probe.once('error', () => resolveBusy(true))
  probe.once('listening', () => { probe.close(); resolveBusy(false) })
  probe.listen(p, '127.0.0.1')
})
if (!force && !dryRun) {
  const busy = []
  for (const p of BUSY_PORTS) if (await portBusy(p)) busy.push(p)
  if (busy.length > 0) {
    console.error(`upgrade-node-version: 端口 ${busy.join(', ')} 被占用——生产栈还在运行，升级会 EPERM 半途而废。`)
    console.error('先停栈：schtasks /end /tn DacManager（或 systemctl stop 对应服务），等节点进程退出后重跑本脚本。')
    process.exit(1)
  }
}
const log = (line) => console.log(`[upgrade-node-version] ${line}`)

if (!existsSync(configPath)) {
  console.error(`upgrade-node-version: ${configPath} not found`)
  process.exit(1)
}
const cfg = parseYaml(readFileSync(configPath, 'utf8'))
const actions = []

const backup = (path) => {
  const bak = `${path}${bakSuffix}`
  if (!existsSync(bak)) {
    if (!dryRun) writeFileSync(bak, readFileSync(path, 'utf8'), 'utf8')
    log(`备份 ${path} → ${bak}`)
  }
}

const npm = (cwd, installArgs) => {
  const full = ['install', ...installArgs, '--no-audit', '--no-fund']
  if (pair.legacyPeerDeps) full.push('--legacy-peer-deps')
  log(`npm ${full.join(' ')} (cwd ${cwd})`)
  if (dryRun) return
  execFileSync('npm', full, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

// ---- 1/2/3: 节点 profile + settings + 全局 DSH ----
const dshPrefixes = new Set()
const keyByVar = new Map()
for (const [id, ep] of Object.entries(cfg.endpoints ?? {})) {
  // schema 默认 runner='process'：原始 yaml 常省略该字段
  const runner = ep?.spawn?.runner ?? 'process'
  if (runner !== 'process') continue
  const home = ep.spawn.env?.DSH_HOME
  const binPath = ep.spawn.args?.[0]
  if (typeof home !== 'string' || typeof binPath !== 'string') continue
  const profileIdx = (ep.spawn.args ?? []).indexOf('--profile')
  const profileName = profileIdx >= 0 ? ep.spawn.args[profileIdx + 1] : null
  if (profileName === null || typeof profileName !== 'string') continue

  const profileDir = join(home, 'profiles', profileName)
  if (!existsSync(join(profileDir, 'package.json'))) {
    log(`⚠ 节点 ${id}: ${profileDir}/package.json 不存在，跳过（外管节点？）`)
    continue
  }
  // 1) profile 钉目标版本 + facade
  const pkgPath = join(profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const deps = { '@deepseek-ai/dsh': TARGET, '@deepseek-ai/dsh-base': TARGET, '@deepseek-ai/dsh-web-app': TARGET, [GATEWAY_PACKAGE]: GATEWAY_REF }
  const next = { ...pkg, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', GATEWAY_PACKAGE] } }, dependencies: deps }
  if (JSON.stringify(pkg) !== JSON.stringify(next)) {
    actions.push(`节点 ${id}: profile 依赖/bundles 钉 ${TARGET}`)
    backup(pkgPath)
    if (!dryRun) writeFileSync(pkgPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    if (!dryRun) rmSync(join(profileDir, 'node_modules'), { recursive: true, force: true })
    npm(profileDir, [])
  } else {
    log(`节点 ${id}: profile 已是 ${TARGET}，跳过`)
  }

  // 2) settings.yaml 铸/复用 facade 钥匙
  const settingsPath = join(home, 'settings.yaml')
  const settings = existsSync(settingsPath) ? parseYaml(readFileSync(settingsPath, 'utf8')) ?? {} : {}
  const ns = settings[GATEWAY_PACKAGE] ?? {}
  let key = typeof ns.provisionedKey === 'string' && ns.provisionedKey !== '' ? ns.provisionedKey
    : (Array.isArray(ns.apiKeys) ? ns.apiKeys.find((k) => k !== '') : undefined)
  if (key === undefined) {
    key = 'apigw-' + randomBytes(24).toString('hex')
    settings[GATEWAY_PACKAGE] = { ...ns, apiKeys: [...(Array.isArray(ns.apiKeys) ? ns.apiKeys : []), key] }
    backup(settingsPath)
    if (!dryRun) writeFileSync(settingsPath, stringifyYaml(settings), 'utf8')
    actions.push(`节点 ${id}: 铸新钥匙写入 ${GATEWAY_PACKAGE} 段`)
  } else {
    log(`节点 ${id}: 复用现有钥匙（${GATEWAY_PACKAGE}）`)
  }
  if (typeof ep.sandbox_key_ref === 'string' && ep.sandbox_key_ref !== '') keyByVar.set(ep.sandbox_key_ref, key)

  // 3) 全局 DSH prefix（bin.js 所在安装目录；隔离安装节点不在此列）
  const marker = '/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const normalizedBin = binPath.replace(/\\/g, '/')
  if (normalizedBin.endsWith(marker)) dshPrefixes.add(normalizedBin.slice(0, -marker.length))
}

// ---- 4) .env：DSH_NODE_IMAGE tag + GW_KEY_* 钥匙同步 ----
{
  const envPath = join(dirname(resolve(configPath)), '.env')
  if (existsSync(envPath)) {
    const envOriginal = readFileSync(envPath, 'utf8')
    const envLines = envOriginal.split(/\r?\n/)
    let touched = false
    for (let i = 0; i < envLines.length; i += 1) {
      const m = /^(DSH_NODE_IMAGE=hellodac\/dac-node:)([^\s]+)$/.exec(envLines[i])
      if (m !== null && m[2] !== TARGET) {
        envLines[i] = `${m[1]}${TARGET}`
        actions.push(`.env: DSH_NODE_IMAGE → hellodac/dac-node:${TARGET}`)
        touched = true
      }
    }
    const seen = new Set()
    for (let i = 0; i < envLines.length; i += 1) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(envLines[i])
      if (m !== null && keyByVar.has(m[1])) {
        envLines[i] = `${m[1]}=${keyByVar.get(m[1])}`
        seen.add(m[1])
        touched = true
      }
    }
    for (const [name, value] of keyByVar) {
      if (!seen.has(name)) { envLines.push(`${name}=${value}`); touched = true }
    }
    if (touched) {
      backup(envPath)
      if (!dryRun) writeFileSync(envPath, envLines.join('\n') + '\n', 'utf8')
    }
  } else {
    log('⚠ .env 不存在，跳过镜像 tag 与钥匙同步')
  }
}

// ---- 全局 DSH 升级 ----
for (const prefix of dshPrefixes) {
  const manifestPath = join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const current = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).version : '缺失'
  if (current === TARGET) {
    log(`全局 DSH 已是 ${TARGET}，跳过`)
  } else {
    actions.push(`全局 DSH: ${current} → ${TARGET}`)
    npm(prefix, [`${COMPAT_DSH_PACKAGE}@${TARGET}`])
  }
}

console.log('')
console.log(dryRun ? '[dry-run] 预演完成，将执行以下动作：' : `执行完成（目标 ${TARGET}）：`)
if (actions.length === 0) console.log(`  （无变化——已是 ${TARGET} 接线）`)
for (const a of actions) console.log('  - ' + a)
if (!dryRun && actions.length > 0) {
  console.log('')
  console.log('下一步：重启 manager 栈（schtasks /run /tn DacManager 或 systemctl start），等待节点探活；')
  console.log('节点页「对齐版本」可对单个节点补对齐（重播种 + 重装 + 重启）。')
}
