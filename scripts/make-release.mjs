// scripts/make-release.mjs — 生成发布包 dac-compose.zip（纯镜像引用，剥离 build 段）。
// 发布者用：DAC_VERSION=v1.0.0 DSH_NODE_IMAGE=... MANAGER_IMAGE=... node scripts/make-release.mjs
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 债务 D5:版本号唯一真相源 = package.json;环境变量只作显式覆盖。
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = process.env.DAC_VERSION ?? `v${pkg.version}`
const nodeImage = process.env.DSH_NODE_IMAGE ?? 'hellodac/dac-node:0.1.2-rc.1'
const managerImage = process.env.MANAGER_IMAGE ?? `hellodac/dac-manager:${version.replace(/^v/, '')}`
const releaseDir = join(root, 'dist-release')
const stage = join(releaseDir, 'stage')

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// ---- compose：剥离 build 段、钉镜像 ----
const compose = parseYaml(readFileSync(join(root, 'docker-compose.yml'), 'utf8'))
delete compose.services.manager.build
compose.services.manager.image = managerImage
delete compose.services['node-brain'].build
compose.services['node-brain'].image = nodeImage
writeFileSync(join(stage, 'docker-compose.yml'), stringifyYaml(compose), 'utf8')

// ---- 静态件 ----
cpSync(join(root, 'manager.config.container.example.yaml'), join(stage, 'manager.config.container.example.yaml'))
cpSync(join(root, 'scripts', 'gen-env.sh'), join(stage, 'scripts', 'gen-env.sh'))
mkdirSync(join(stage, 'deploy', 'nginx'), { recursive: true })
for (const f of ['default.conf.example', 'tls-origin-ca.conf', 'tls-letsencrypt.conf', 'tls-none.conf']) {
  cpSync(join(root, 'deploy', 'nginx', f), join(stage, 'deploy', 'nginx', f))
}
// 发布包开箱即用：运行时 default.conf 是生成物（gitignore），随包预生成 HTTP 直连形态；
// 域名/TLS 用户用 install.sh 重跑即换模板（同线上行为）。
cpSync(join(stage, 'deploy', 'nginx', 'default.conf.example'), join(stage, 'deploy', 'nginx', 'default.conf'))
writeFileSync(
  join(stage, 'README.txt'),
  [
    'DAC 发布包（compose 三件套）',
    '',
    '快速开始：',
    '  DEEPSEEK_API_KEY=sk-xxx bash scripts/gen-env.sh .env',
    '  cp manager.config.container.example.yaml manager.config.yaml',
    '  docker compose up -d',
    '',
    '完整文档：https://github.com/litestartup-com/hellodac',
  ].join('\n'),
  'utf8',
)

// ---- 打包 zip（跨平台：Windows 用 Compress-Archive，其余用 zip） ----
rmSync(join(releaseDir, 'dac-compose.zip'), { force: true })
if (process.platform === 'win32') {
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${join(stage, '*')}' -DestinationPath '${join(releaseDir, 'dac-compose.zip')}' -Force`,
  ])
} else {
  execFileSync('zip', ['-qr', join(releaseDir, 'dac-compose.zip'), '.'], { cwd: stage })
}

console.log(`[make-release] ${join(releaseDir, 'dac-compose.zip')}`)
console.log(`[make-release] compose: manager=${managerImage} node=${nodeImage} (${version})`)
