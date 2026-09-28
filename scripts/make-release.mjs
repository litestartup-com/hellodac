// scripts/make-release.mjs — build the release archive dac-compose.zip (pure image references, build section stripped).
// For publishers: DAC_VERSION=v1.0.0 DSH_NODE_IMAGE=... MANAGER_IMAGE=... node scripts/make-release.mjs
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Debt D5: the single source of truth for the version number = package.json; environment variables are explicit overrides only.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = process.env.DAC_VERSION ?? `v${pkg.version}`
const nodeImage = process.env.DSH_NODE_IMAGE ?? 'hellodac/dac-node:0.1.2-rc.1'
const managerImage = process.env.MANAGER_IMAGE ?? `hellodac/dac-manager:${version.replace(/^v/, '')}`
const releaseDir = join(root, 'dist-release')
const stage = join(releaseDir, 'stage')

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// ---- compose: strip the build section, pin the images ----
const compose = parseYaml(readFileSync(join(root, 'docker-compose.yml'), 'utf8'))
delete compose.services.manager.build
compose.services.manager.image = managerImage
delete compose.services['node-brain'].build
compose.services['node-brain'].image = nodeImage
writeFileSync(join(stage, 'docker-compose.yml'), stringifyYaml(compose), 'utf8')

// ---- static files ----
cpSync(join(root, 'manager.config.container.example.yaml'), join(stage, 'manager.config.container.example.yaml'))
cpSync(join(root, 'scripts', 'gen-env.sh'), join(stage, 'scripts', 'gen-env.sh'))
mkdirSync(join(stage, 'deploy', 'nginx'), { recursive: true })
for (const f of ['default.conf.example', 'tls-origin-ca.conf', 'tls-letsencrypt.conf', 'tls-none.conf']) {
  cpSync(join(root, 'deploy', 'nginx', f), join(stage, 'deploy', 'nginx', f))
}
// The release archive works out of the box: the runtime default.conf is a generated file (gitignored),
// so it ships pre-generated in the plain-HTTP direct form; a domain/TLS user re-runs install.sh to swap
// the template (the same behavior as in production).
cpSync(join(stage, 'deploy', 'nginx', 'default.conf.example'), join(stage, 'deploy', 'nginx', 'default.conf'))
writeFileSync(
  join(stage, 'README.txt'),
  [
    'DAC release archive (the compose trio)',
    '',
    'Quick start:',
    '  DEEPSEEK_API_KEY=sk-xxx bash scripts/gen-env.sh .env',
    '  cp manager.config.container.example.yaml manager.config.yaml',
    '  docker compose up -d',
    '',
    'Full documentation: https://github.com/litestartup-com/hellodac',
  ].join('\n'),
  'utf8',
)

// ---- pack the zip (cross-platform: Compress-Archive on Windows, zip elsewhere) ----
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
