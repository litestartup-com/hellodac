// scripts/release-check.mjs —— 发布自检（B6 用：发布日跑一条命令看红绿）。
//
// 把「发布 DoD」里机器能判定的部分固化下来，避免靠记忆走清单：
//   1. 全套门禁（typecheck / lint / test / test:web / i18n:check / build / check-docs）
//   2. 静态项：必需文件在不在、LICENSE 署名、语言包 parity、镜像依赖锁、落地页、
//      CHANGELOG 有 v1.0.0 条目、仓库里不该残留的旧品牌名（白名单外）
// 用法：
//   npm run release:check            # 全量（含两条测试套件）
//   npm run release:check -- --quick # 跳过测试套件（改文案/文档时快速自检）
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const quick = process.argv.includes('--quick')
const results = []

const run = (label, command, args = []) => {
  const started = Date.now()
  try {
    execFileSync(command, args, { cwd: root, stdio: 'pipe', shell: process.platform === 'win32' })
    results.push({ ok: true, label, ms: Date.now() - started })
  } catch (error) {
    const out = String(error.stdout ?? '') + String(error.stderr ?? '')
    results.push({ ok: false, label, ms: Date.now() - started, detail: out.trim().split('\n').slice(-6).join('\n      ') })
  }
}

const check = (label, fn) => {
  try {
    const detail = fn()
    results.push({ ok: detail === true || detail === undefined, label, detail: detail === true ? undefined : detail })
  } catch (error) {
    results.push({ ok: false, label, detail: error instanceof Error ? error.message : String(error) })
  }
}

// ---- 1. 门禁 ----
run('typecheck', 'npm', ['run', 'typecheck'])
run('lint（0 error）', 'npm', ['run', 'lint'])
if (!quick) {
  run('后端测试', 'npm', ['test'])
  run('前端测试', 'npm', ['run', 'test:web'])
}
run('i18n 键守卫', 'npm', ['run', 'i18n:check'])
run('build', 'npm', ['run', 'build'])
run('check-docs', 'node', ['scripts/check-docs.mjs'])

// ---- 2. 静态项 ----
check('必需文件齐备（LICENSE/SECURITY/CONTRIBUTING/CODE_OF_CONDUCT/README.zh）', () => {
  const missing = ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'README.md', 'README.zh.md', '.github/PULL_REQUEST_TEMPLATE.md'].filter(
    (f) => !existsSync(join(root, f)),
  )
  return missing.length === 0 ? true : `缺：${missing.join(', ')}`
})

check('LICENSE 署名 = Litestartup', () => {
  const text = readFileSync(join(root, 'LICENSE'), 'utf8')
  return text.includes('Copyright (c) 2026 Litestartup') ? true : 'LICENSE 署名未更新'
})

check('语言包 parity（en/zh 键集合一致且无空值）', () => {
  const en = JSON.parse(readFileSync(join(root, 'src/i18n/locales/en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(join(root, 'src/i18n/locales/zh-CN.json'), 'utf8'))
  const ek = Object.keys(en)
  const zk = Object.keys(zh)
  if (ek.length !== zk.length) return `键数不同：en ${ek.length} / zh ${zk.length}`
  const diff = ek.filter((k) => !(k in zh))
  if (diff.length > 0) return `zh 缺键：${diff.slice(0, 5).join(', ')}`
  const empty = ek.filter((k) => String(en[k]).trim() === '' || String(zh[k]).trim() === '')
  return empty.length === 0 ? true : `空值：${empty.join(', ')}`
})

check('容器节点镜像依赖锁齐备（每个受支持 DSH 版本）', () => {
  const matrix = readFileSync(join(root, 'src/dsh-matrix.ts'), 'utf8')
  const versions = [...matrix.matchAll(/\{ dsh: '([^']+)'/g)].map((m) => m[1])
  const missing = versions.filter((v) => !existsSync(join(root, 'images/node/profile-lock', `${v}.package-lock.json`)))
  return missing.length === 0 ? true : `缺锁：${missing.join(', ')}（npm run lock:profile）`
})

check('落地页存在（hellodac.com 用）', () => {
  const file = join(root, 'landing', 'index.html')
  if (!existsSync(file)) return '缺 landing/index.html'
  const html = readFileSync(file, 'utf8')
  return html.includes('One Manager. A Fleet of Agents.') ? true : '落地页缺标语'
})

check('CHANGELOG 有 v1.0.0 对外条目', () => {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  return /## v1\.0\.0/.test(text) ? true : 'CHANGELOG 缺 v1.0.0 条目'
})

check('版本号单一口径（pkg / version.ts / compose / install.sh / 锁文件 / 文档钉版 URL）', () => {
  // 为什么值得一条守卫：发布前版本散落在 6 个地方，漏一处就是「装的还是上一版」
  // 或「复制到的安装地址 404」。2026-09-24 实况：pkg 1.1.1 / compose 兜底 1.0.3 /
  // 文档 URL v1.1.1 三个口径并存。
  const read = (rel) => readFileSync(join(root, rel), 'utf8')
  const version = JSON.parse(read('package.json')).version
  const bad = []
  const expect = (label, actual) => {
    if (actual !== version) bad.push(`${label}: ${String(actual)}（期望 ${version}）`)
  }
  expect('src/version.ts', /MANAGER_VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1])
  expect('docker-compose.yml 镜像兜底', /dac-manager:\$\{MANAGER_VERSION:-([^}]+)\}/.exec(read('docker-compose.yml'))?.[1])
  expect('install.sh DAC_VERSION', /DAC_VERSION:-v([^}]+)\}/.exec(read('install.sh'))?.[1])
  const lock = JSON.parse(read('package-lock.json'))
  expect('package-lock.json', lock.version)
  expect('package-lock.json 根包', lock.packages?.['']?.version)
  // 文档/脚本里的钉版 URL：必须以 https:// 紧接主机名，否则会把 codeload.github.com 的
  // `zip/refs/heads/master` 也当成版本引用（分支引用是合法的，跳过）。
  const refRe = /https:\/\/(?:raw\.githubusercontent\.com\/litestartup-com\/hellodac|github\.com\/litestartup-com\/hellodac\/blob)\/([A-Za-z0-9._-]+)\//g
  for (const rel of ['README.md', 'README.zh.md', 'docs/USER-GUIDE.md', 'install.sh', 'install.ps1', 'landing/index.html']) {
    for (const m of read(rel).matchAll(refRe)) {
      if (m[1] === 'main' || m[1] === 'master') continue
      if (m[1] !== `v${version}`) bad.push(`${rel}: 钉版 ${m[1]}（期望 v${version}）`)
    }
  }
  return bad.length === 0 ? true : bad.slice(0, 6).join('；')
})

check('旧品牌名已清零（B2 更名后转绿）', () => {
  // 白名单与 scripts/rename-to-dac.mjs 保持一致：gateway 包名/仓库、加密格式常量、
  // 历史流水账、本地笔记、脚本自身。
  const whitelist = ['ohdsh-api-facade', 'dsh-api-gateway', 'OHDSH-BAK2', 'OHDSH-BAK1', 'ohdsh-backup-v2', 'ohdsh-backup:']
  // B2 更名期的前端 CSRF 双读过渡白名单已随生产 cutover（2026-09-24 13:30）删除：
  // 现在两侧都是新代码，仓库里不该再有第二个口径。
  const skipFiles = new Set(['CHANGELOG.md', 'CONTEXT.md', 'RULE.md', 'scripts/rename-to-dac.mjs', 'scripts/release-check.mjs'])
  // 作用域 = **git 跟踪集**，不是文件系统：gitignore 里的 `manager.config.yaml` 是这台机器
  // 当下的生产真相源（cutover 前它的路径本来就还是 `~/.dsh-ohdsh`），扫它等于让守卫
  // 去管「本机部署状态」而不是「仓库内容」。2026-09-24 实撞：sweep 误改配置时这条守卫
  // 反而是**绿**的（配置里旧名被改没了），还原后立刻变红——两头都不对。
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\u0000')
    .filter((s) => s !== '')
  const offenders = []
  for (const rel of tracked) {
    if (skipFiles.has(rel)) continue
    if (!/\.(ts|js|mjs|json|ya?ml|md|sh|ps1|cmd|html|css|conf|example|txt)$/.test(rel) && !/(^|\/)Dockerfile/.test(rel)) continue
    let text = readFileSync(join(root, rel), 'utf8')
    for (const needle of whitelist) text = text.split(needle).join('')
    if (/ohdsh/i.test(text)) offenders.push(rel)
  }
  return offenders.length === 0 ? true : `仍含 ohdsh：${offenders.slice(0, 8).join(', ')}`
})

// ---- 报告 ----
const pad = (s, n) => String(s).padEnd(n)
console.log(`\n发布自检（${quick ? 'quick' : '全量'}）—— 仓库 ${root}\n`)
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'}  ${pad(r.label, 34)} ${r.ms === undefined ? '' : `${(r.ms / 1000).toFixed(1)}s`}`)
  if (!r.ok && r.detail !== undefined) console.log(`      ${r.detail}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length > 0 ? `，${failed.length} 项未通过` : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
