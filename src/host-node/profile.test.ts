import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileFiles, profileDependencies, dshBinInProfile, ensureNodeProfiles, profileSeed, currentProfileSeed, profileDrift, profileInstallCommand } from './profile.js'
import { COMPAT_DSH_VERSION, GATEWAY_PACKAGE, GATEWAY_REF } from '../dsh-version.js'

test('能力一回归: profile 依赖含 @deepseek-ai/dsh 自身（隔离安装后不依赖全局 dsh）', () => {
  const deps = profileDependencies()
  assert.equal(deps['@deepseek-ai/dsh'], COMPAT_DSH_VERSION, 'dsh 包钉兼容版本')
  assert.equal(deps['@deepseek-ai/dsh-base'], COMPAT_DSH_VERSION)
  assert.equal(deps['@deepseek-ai/dsh-web-app'], COMPAT_DSH_VERSION)
  assert.equal(deps[GATEWAY_PACKAGE], GATEWAY_REF)
})

test('舰队 M1-6 回归: bundles 钉目标版本而非矩阵首行——0.1.5 节点不许拿 0.1.2 bundles', () => {
  const deps = profileDependencies('0.1.5-rc.2')
  assert.equal(deps['@deepseek-ai/dsh'], '0.1.5-rc.2')
  assert.equal(deps['@deepseek-ai/dsh-base'], '0.1.5-rc.2', 'dsh-base 必须跟目标版本')
  assert.equal(deps['@deepseek-ai/dsh-web-app'], '0.1.5-rc.2', 'dsh-web-app 必须跟目标版本')
})

test('舰队 M1-7 回归: profileFiles 绑地址可参数化——缺省 127.0.0.1，agent 远端 0.0.0.0', () => {
  const dflt = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF)
  assert.match(dflt['cordis.patch.yml'] ?? '', /host: 127\.0\.0\.1/, '裸机默认只绑回环（GUI 红线）')
  const remote = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF, COMPAT_DSH_VERSION, '0.0.0.0')
  assert.match(remote['cordis.patch.yml'] ?? '', /host: 0\.0\.0\.0/, 'agent 远端节点绑 0.0.0.0（防火墙白名单兜底）')
})

test('能力一回归: profileFiles 的 package.json 携带 dsh 依赖与 bundles 清单', () => {
  const files = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF)
  const pkg = JSON.parse(files['package.json'] ?? '{}')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh'], COMPAT_DSH_VERSION)
  assert.ok(Array.isArray(pkg.dsh?.profile?.bundles), 'bundles 清单保留')
  assert.ok(pkg.dsh.profile.bundles.includes(GATEWAY_PACKAGE))
  // patch 仍绑 loopback + 节点端口（stringifyYaml 输出不带引号）
  assert.match(files['cordis.patch.yml'] ?? '', /host: 127\.0\.0\.1/)
  assert.match(files['cordis.patch.yml'] ?? '', /port: 3083/)
})

test('能力一回归: dshBinInProfile——隔离安装后指向 profile 内 bin，未装则 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-node-'))
  try {
    assert.equal(dshBinInProfile(join(dir, 'nope')), null, '未安装 = null')
    const binDir = join(dir, 'profiles', 'worker', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'bin.js'), '', 'utf8')
    assert.equal(dshBinInProfile(join(dir, 'profiles', 'worker')), join(binDir, 'bin.js'), '指向 profile 内 bin.js')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力二回归: profileInstallCommand 按矩阵配对追加 --legacy-peer-deps（dsh-facts §12）', () => {
  const legacy = profileInstallCommand('win32', '0.1.5-rc.2')
  assert.ok(legacy.args.includes('--legacy-peer-deps'), '0.1.5 配对必须带 flag（facade peer 区间不覆盖 → ERESOLVE）')
  const clean = profileInstallCommand('win32', '0.1.2-rc.1')
  assert.ok(!clean.args.includes('--legacy-peer-deps'), '0.1.2 配对不需要')
  const dflt = profileInstallCommand('linux')
  assert.ok(!dflt.args.includes('--legacy-peer-deps'), '缺省（矩阵首行）不带')
  assert.equal(clean.cmd, 'npm')
})

test('能力二回归: .seed-version 标记与漂移判定——生成即带标记，版本/ref 变化即漂移', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'host-node-seed-'))
  try {
    ensureNodeProfiles(nodesHome, [{ name: 'worker', port: 3083 }], GATEWAY_REF)
    const profileDir = join(nodesHome, 'worker', 'profiles', 'worker')
    const marker = join(profileDir, '.seed-version')
    assert.ok(readFileSync(marker, 'utf8').trim().length === 40, '生成即带 sha1 标记')
    assert.equal(currentProfileSeed(profileDir), profileSeed(COMPAT_DSH_VERSION, GATEWAY_REF))
    assert.equal(profileDrift(profileDir, COMPAT_DSH_VERSION, GATEWAY_REF), false, '同版本同 ref = 无漂移')
    assert.equal(profileDrift(profileDir, '0.1.5-rc.2', GATEWAY_REF), true, '版本变化 = 漂移')
    assert.equal(profileDrift(profileDir, COMPAT_DSH_VERSION, 'github:litestartup-com/dsh-api-gateway#deadbeef'), true, 'ref 变化 = 漂移')
    // 未生成过（目录存在但无标记）= 视同漂移（存量老 profile 对齐入口）
    const legacy = join(nodesHome, 'legacy', 'profiles', 'legacy')
    mkdirSync(legacy, { recursive: true })
    assert.equal(profileDrift(legacy, COMPAT_DSH_VERSION, GATEWAY_REF), true, '无标记的存量 profile = 漂移')
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})

test('舰队 M1 试点回归: 0.1.5-rc.2 profile 必须补 legacy 跳过的 peer + 携带锁文件 + patchReload startup（Windows 实证：新装整树漂 rc.3 + peer 缺失 → 启动即崩）', () => {
  const files = profileFiles({ name: 'pilot01', port: 3197 }, GATEWAY_REF, '0.1.5-rc.2')
  const pkg = JSON.parse(files['package.json'] ?? '{}')
  assert.equal(pkg.dependencies['@deepseek-ai/cordis-plugin-group'], '1.0.2', 'dsh-app-boot 静态导入的 peer（legacy 跳过）必须显式补上')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-sandbox'], '0.1.5-rc.3', '旧家族名 peer 显式补上（rc.3 家族版本）')
  assert.equal(pkg.dependencies['@deepseek-ai/cordis-plugin-hmr'], '1.0.17', 'HMR peer 显式补上')
  assert.equal(pkg.dsh?.profile?.patchReload, 'startup', '节点 profile 不启用 live patch 监听（免 HMR 硬依赖，实证默认 live 会崩）')
  assert.ok(files['package-lock.json'] !== undefined, 'profileFiles 必须随送锁文件——0.1.5-rc.2 的 ^ 区间会漂到 rc.3（registry next）')
  const lock = JSON.parse(files['package-lock.json'] ?? '{}')
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh']?.version, '0.1.5-rc.2', '锁文件钉住 dsh 自身')
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh-app-boot']?.version, '0.1.5-rc.3', '锁文件钉住家族快照（rc.3 家族实证可启动）')
  assert.equal(lock.packages['node_modules/@deepseek-ai/cordis-plugin-group']?.version, '1.0.2', '锁含显式 peer')
  // 0.1.2 线不需要锁与补丁（^0.1.2-rc.1 无同 tuple 新版本可漂；无 legacy 时 npm 自动装 peer）
  const clean = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF, '0.1.2-rc.1')
  const cleanPkg = JSON.parse(clean['package.json'] ?? '{}')
  assert.ok(clean['package-lock.json'] === undefined, '0.1.2 不带锁')
  assert.ok(cleanPkg.dependencies['@deepseek-ai/cordis-plugin-group'] === undefined, '0.1.2 不补 peer')
})
