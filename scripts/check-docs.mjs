// scripts/check-docs.mjs — CI 门禁（蜂群2计划 P0/P6）：
// 1) README.md 的仓库内 markdown 链接必须指向存在的文件（外部 http/mailto 链接不校验）；
// 2) README/CHANGELOG 禁止手写测试数（数字由 CI 断言，禁绝漂移）；
// 3) 部署文件完整性：compose 引用的本地文件存在；容器示例配置可解析且形态正确。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

// ---- 1) 死链：仓库内相对链接必须解析到真实文件 ----
for (const rel of ['README.md']) {
  const text = readFileSync(join(root, rel), 'utf8')
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1].trim()
    if (target === '' || /^(https?:|mailto:)/i.test(target)) continue
    const path = resolve(root, target.replace(/^\.\//, ''))
    if (!existsSync(path)) failures.push(`${rel}: 死链 \`${target}\``)
  }
}

// ---- 2) 手写测试数：README/CHANGELOG 不得出现「N 测试/tests」字样 ----
for (const rel of ['README.md', 'CHANGELOG.md']) {
  const text = readFileSync(join(root, rel), 'utf8')
  const hits = text.match(/\d{2,4}\s*(tests?|测试|用例)/gi) ?? []
  if (hits.length > 0) failures.push(`${rel}: 手写测试数（禁绝）→ ${hits.join(', ')}`)
}

// ---- 3) 部署文件完整性 ----
try {
  const compose = parseYaml(readFileSync(join(root, 'docker-compose.yml'), 'utf8'))
  const services = compose?.services ?? {}
  for (const name of ['nginx', 'manager', 'node-brain']) {
    if (services[name] === undefined) failures.push(`docker-compose.yml: 缺少服务 ${name}`)
  }
  for (const rel of [
    'deploy/nginx/default.conf.example',
    'images/node/Dockerfile',
    'images/node/entrypoint.sh',
    'images/node/gen-node-profile.mjs',
    'images/manager/Dockerfile',
    'manager.config.container.example.yaml',
    'scripts/gen-env.sh',
  ]) {
    if (!existsSync(join(root, rel))) failures.push(`部署文件缺失: ${rel}`)
  }
  const example = parseYaml(readFileSync(join(root, 'manager.config.container.example.yaml'), 'utf8'))
  if (example?.endpoints?.brain?.sandbox_key_ref !== 'GW_KEY_B') failures.push('容器示例配置: brain 缺少 sandbox_key_ref=GW_KEY_B')
  if (example?.endpoints?.personal?.spawn?.runner !== 'docker') failures.push('容器示例配置: personal 应为 docker runner')
  if (!Array.isArray(example?.backup?.docker_volumes) || !example.backup.docker_volumes.includes('dac-brain')) {
    failures.push('容器示例配置: backup.docker_volumes 应含 dac-brain')
  }
} catch (error) {
  failures.push(`部署文件校验失败: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 4) 债务 H1:manager 容器非 root + docker.sock 降权接线 + nginx 封内网面 ----
try {
  const managerDockerfile = readFileSync(join(root, 'images/manager/Dockerfile'), 'utf8')
  if (!/^\s*USER\s+\d+:\d+\s*$/m.test(managerDockerfile)) {
    failures.push('images/manager/Dockerfile: 缺少 USER 指令（manager 容器必须非 root）')
  }
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
  if (!/group_add/.test(compose)) failures.push('docker-compose.yml: manager 缺少 group_add（docker.sock 经宿主 docker 组 GID 访问）')
  if (!/\$\{DOCKER_GID:/.test(compose)) failures.push('docker-compose.yml: group_add 应引用 DOCKER_GID（gen-env.sh 探测宿主 docker 组）')
  for (const rel of ['deploy/nginx/default.conf.example', 'deploy/nginx/tls-none.conf', 'deploy/nginx/tls-origin-ca.conf', 'deploy/nginx/tls-letsencrypt.conf']) {
    const conf = readFileSync(join(root, rel), 'utf8')
    if (!conf.includes('location /api/internal/')) failures.push(`${rel}: 缺少 /api/internal/ 反代块`)
    if (!conf.includes('deny all')) failures.push(`${rel}: /api/internal/ 缺少私网 ACL（deny all）`)
  }
} catch (error) {
  failures.push(`H1 部署加固校验失败: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 5) 容器部署红线静态断言（compose-e2e 2026-09-14 首次实证四坑，复盘见设计库
//          manager/facts/container-deploy-facts.md——红线 A/B/C/D 的 CI 侧拦网）----
try {
  // 红线 A：每条引导路径都必须写 HOST_UID/HOST_GID（容器 uid = 宿主文件属主；缺失 → SQLITE_CANTOPEN）
  const genEnv = readFileSync(join(root, 'scripts/gen-env.sh'), 'utf8')
  for (const v of ['HOST_UID', 'HOST_GID']) {
    if (!genEnv.includes(`ensure ${v} `)) failures.push(`scripts/gen-env.sh: 必须写入 ${v}（红线 A：容器 uid 与宿主文件属主同源）`)
  }
  // 红线 B：运行时 uid 参数化 → 运行时写目录必须 uid 无关（命名卷根 777、HOME 落可写卷）
  const nodeDockerfile = readFileSync(join(root, 'images/node/Dockerfile'), 'utf8')
  if (!nodeDockerfile.includes('chmod 777 /data')) failures.push('images/node/Dockerfile: /data 卷根必须 chmod 777（红线 B：HOST_UID≠1000 时命名卷属主 EACCES）')
  if (!nodeDockerfile.includes('HOME=/data')) failures.push('images/node/Dockerfile: 必须 HOME=/data（.brain-auth 等运行时写入落可写卷）')
  // 红线 C：真相文件原子写（.tmp+rename）要求所在目录可写（/app 是镜像层 root 属主）
  const managerDockerfile2 = readFileSync(join(root, 'images/manager/Dockerfile'), 'utf8')
  if (!managerDockerfile2.includes('chmod 777 /app')) failures.push('images/manager/Dockerfile: /app 必须放写（红线 C：真相文件 .tmp+rename 原子写需要目录写权限）')
  // 红线 D：节点卷备份必须走 runToolIo 流式传输（容器内绝对路径做 bind 源 = 宿主路径幻觉）
  const nodebackup = readFileSync(join(root, 'src/nodebackup.ts'), 'utf8')
  if (!nodebackup.includes('runToolIo')) failures.push('src/nodebackup.ts: 节点卷备份必须走 runToolIo（红线 D：禁止把容器内备份目录当宿主路径 bind）')
} catch (error) {
  failures.push(`容器部署红线断言失败: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 6) 能力二（2026-09-20）：钉版同步守卫——DSH/gateway 钉版只许来自版本矩阵
//          src/dsh-matrix.ts；安装器/镜像/升级脚本/发布包出现不一致 = CI 即红 ----
try {
  const matrixSrc = readFileSync(join(root, 'src/dsh-matrix.ts'), 'utf8')
  const defaultDsh = /dsh: '([^']+)'/.exec(matrixSrc)?.[1] ?? ''
  const gatewayRef = /GATEWAY_REF = '([^']+)'/.exec(matrixSrc)?.[1] ?? ''
  const pinChecks = [
    ['install.ps1', /\$DSH_VERSION = '([^']+)'/, defaultDsh],
    ['images/node/gen-node-profile.mjs', /DSH_VERSION = process\.env\.DSH_VERSION \?\? '([^']+)'/, defaultDsh],
    ['images/node/gen-node-profile.mjs', /GATEWAY_REF = process\.env\.GATEWAY_REF \?\? '([^']+)'/, gatewayRef],
    ['images/node/Dockerfile', /ARG DSH_VERSION=([^\s]+)/, defaultDsh],
    ['images/node/Dockerfile', /ARG GATEWAY_REF=([^\s]+)/, gatewayRef],
    ['scripts/upgrade-node-version.mjs', /GATEWAY_REF = '([^']+)'/, gatewayRef],
    ['scripts/make-release.mjs', /nodeImage = process\.env\.DSH_NODE_IMAGE \?\? 'hellodac\/dac-node:([^']+)'/, defaultDsh],
  ]
  for (const [file, re, expected] of pinChecks) {
    const content = readFileSync(join(root, file), 'utf8')
    const match = re.exec(content)
    if (match === null) {
      failures.push(`${file}: 找不到钉版字面量（能力二守卫；格式变更请同步本断言）`)
      continue
    }
    if (match[1] !== expected) {
      failures.push(`${file}: 钉版 ${match[1]} 与版本矩阵不一致（期望 ${expected}）——统一改 src/dsh-matrix.ts，禁止多点手改`)
    }
  }
  // 升级脚本的 SUPPORTED 表 = 矩阵行集合（dsh 列表 + needsLegacyPeerDeps 对齐）——
  // 矩阵加行/改 flag 而脚本表漏改 = CI 红。
  const upgradeSrc = readFileSync(join(root, 'scripts/upgrade-node-version.mjs'), 'utf8')
  const matrixDsh = [...matrixSrc.matchAll(/dsh: '([^']+)'/g)].map((m) => m[1])
  const matrixLegacy = [...matrixSrc.matchAll(/dsh: '([^']+)',[^\n]*needsLegacyPeerDeps: true/g)].map((m) => m[1])
  for (const v of matrixDsh) {
    if (!upgradeSrc.includes(`dsh: '${v}'`)) failures.push(`scripts/upgrade-node-version.mjs: SUPPORTED 表缺矩阵行 ${v}`)
  }
  const scriptRows = [...upgradeSrc.matchAll(/\{ dsh: '([^']+)', legacyPeerDeps: (true|false) \}/g)]
  for (const v of matrixDsh) {
    const row = scriptRows.find((m) => m[1] === v)
    if (row === undefined) continue
    const wantsLegacy = matrixLegacy.includes(v)
    if ((row[2] === 'true') !== wantsLegacy) failures.push(`scripts/upgrade-node-version.mjs: 行 ${v} 的 legacyPeerDeps=${row[2]} 与矩阵 needsLegacyPeerDeps=${wantsLegacy} 不一致`)
  }
  // 容器构建脚本的 LEGACY_PEER_DEPS_VERSIONS = 矩阵 needsLegacyPeerDeps 行集合——
  // 构建 0.1.5 镜像时 profile 安装不带 --legacy-peer-deps 必 ERESOLVE（dsh-facts §12）。
  const genProfileSrc = readFileSync(join(root, 'images/node/gen-node-profile.mjs'), 'utf8')
  const legacyListMatch = /const LEGACY_PEER_DEPS_VERSIONS = \[([^\]]*)\]/.exec(genProfileSrc)
  if (legacyListMatch === null) {
    failures.push('images/node/gen-node-profile.mjs: 缺 LEGACY_PEER_DEPS_VERSIONS 声明（能力二守卫；格式变更请同步本断言）')
  } else {
    const scriptLegacy = [...legacyListMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    for (const v of matrixLegacy) {
      if (!scriptLegacy.includes(v)) failures.push(`images/node/gen-node-profile.mjs: LEGACY_PEER_DEPS_VERSIONS 缺矩阵行 ${v}`)
    }
    for (const v of scriptLegacy) {
      if (!matrixLegacy.includes(v)) failures.push(`images/node/gen-node-profile.mjs: LEGACY_PEER_DEPS_VERSIONS 的 ${v} 在矩阵里不是 needsLegacyPeerDeps`)
    }
  }
  // 搬家重钉守卫（2026-09-20）：install.sh 每次运行都要把 host_volumes 的
  // 宿主侧工作区路径重钉到安装目录真实绝对路径（评审 B2 扩展）——目录搬家后
  // cd 进去重跑 install.sh 即收敛的前提；sed 被删/改坏 = CI 红。
  const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
  if (!installSh.includes('APP_DIR_ABS}/workspaces')) {
    failures.push('install.sh: 缺 host_volumes 宿主侧路径重钉 sed（搬家重钉守卫）')
  }
  // node-agent 的 LEGACY_PEER_DEPS_VERSIONS = 矩阵 needsLegacyPeerDeps 行集合
  // （agent 独立运行无法 import TS 矩阵，双份清单由本守卫钉同步）。
  const agentRuntime = readFileSync(join(root, 'public/assets/agent/runtime.mjs'), 'utf8')
  const agentLegacyMatch = /LEGACY_PEER_DEPS_VERSIONS = \[([^\]]*)\]/.exec(agentRuntime)
  if (agentLegacyMatch === null) {
    failures.push('public/assets/agent/runtime.mjs: 缺 LEGACY_PEER_DEPS_VERSIONS 声明（能力四守卫）')
  } else {
    const agentLegacy = [...agentLegacyMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    for (const v of matrixLegacy) {
      if (!agentLegacy.includes(v)) failures.push(`public/assets/agent/runtime.mjs: LEGACY_PEER_DEPS_VERSIONS 缺矩阵行 ${v}`)
    }
    for (const v of agentLegacy) {
      if (!matrixLegacy.includes(v)) failures.push(`public/assets/agent/runtime.mjs: LEGACY_PEER_DEPS_VERSIONS 的 ${v} 在矩阵里不是 needsLegacyPeerDeps`)
    }
  }
  // M1 试点 Windows 回归：npm 必须 shell:true（.cmd 垫片，无 shell = ENOENT/EINVAL），
  // 安装目录只走 cwd（--prefix 传路径，带空格会被 shell 连接时拆断）。
  if (!/shell:\s*true/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: npm 调用缺 shell:true（Windows .cmd 垫片 ENOENT 回归点）')
  }
  if (/'--prefix'/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: npm 安装不得用 --prefix 传路径（空格路径会被 shell 拆断，改走 cwd）')
  }
  if (!/spawnInvocation\s*=/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: 缺 spawnInvocation（win32 spawn bin.js = EFTYPE，必须经 node 执行）')
  }
  if (!/profileBin !== null && this\.fs\.exists\(profileBin\)/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: execSpawn 未优先 profile-local bin（prefix 树缺 legacy peer，启动即崩——M1 试点实证）')
  }
  if (!/execDeliver/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: 缺 config.deliver 身份轮换处理（M4-1 轮换指令落地端）')
  }
  if (!/NODE_LOG_MAX_BYTES/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: 缺 NODE_LOG_MAX_BYTES 轮转上限（M4-2 日志限额）')
  }
  // M4-3：入口依赖 update.mjs——两个 join 安装脚本必须随包下载，缺 = 装完即崩
  const joinPs1 = readFileSync(join(root, 'scripts/join.ps1'), 'utf8')
  const joinSh = readFileSync(join(root, 'public/assets/agent/join.sh'), 'utf8')
  if (!joinPs1.includes('update.mjs')) failures.push('scripts/join.ps1: 未下载 update.mjs（agent 入口依赖，缺 = 装完即崩）')
  if (!joinSh.includes('update.mjs')) failures.push('public/assets/agent/join.sh: 未下载 update.mjs（agent 入口依赖，缺 = 装完即崩）')
  // M2 实测：DSH 0.1.5 启动器依赖 import.meta.main（Node ≥22.18），22.17 静默
  // 退出 0——join 脚本必须有真实版本门禁（不是只查 node 存在）。
  if (!joinSh.includes('22.18')) failures.push('public/assets/agent/join.sh: 缺 Node ≥22.18 版本门禁（import.meta.main 静默退出实证）')
  if (!joinPs1.includes('22.18')) failures.push('scripts/join.ps1: 缺 Node ≥22.18 版本门禁（import.meta.main 静默退出实证）')
  if (!/\/api\/agents\/:id\/rotate/.test(readFileSync(join(root, 'src/routes/agents.ts'), 'utf8'))) {
    failures.push('src/routes/agents.ts: 缺 /api/agents/:id/rotate 轮换端点（M4-1）')
  }
  // M1 试点实证（dsh-facts §14）：0.1.5-rc.2 的 legacy 装法跳过全部 peer →
  // 显式 peer 清单（profile.ts 与 gen-node-profile.mjs 两份）必须逐字一致；
  // 锁文件 PROFILE_LOCKS 必须覆盖矩阵所有 needsLegacyPeerDeps 行。
  const profileSrc = readFileSync(join(root, 'src/host-node/profile.ts'), 'utf8')
  const pinPairs = (src, anchor) => {
    const block = new RegExp(`${anchor}[\\s\\S]*?= \\{([\\s\\S]*?)\\n\\}`, 'm').exec(src)
    return block === null ? null : new Map([...block[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))
  }
  const tsPins = pinPairs(profileSrc, 'LEGACY_PEER_PINS')
  const mjsPins = pinPairs(readFileSync(join(root, 'images/node/gen-node-profile.mjs'), 'utf8'), 'const LEGACY_PEER_PINS')
  const pinSetsEqual = (a, b) => a !== null && b !== null && a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
  if (tsPins === null) failures.push('src/host-node/profile.ts: 缺 LEGACY_PEER_PINS 声明（legacy peer 补齐清单）')
  if (mjsPins === null) failures.push('images/node/gen-node-profile.mjs: 缺 LEGACY_PEER_PINS 声明（与 profile.ts 同步）')
  if (!pinSetsEqual(tsPins, mjsPins)) failures.push('profile.ts 与 gen-node-profile.mjs 的 LEGACY_PEER_PINS 不一致（两份清单必须逐字同步）')
  if (!/patchReload:\s*'startup'/.test(profileSrc)) failures.push('src/host-node/profile.ts: profile manifest 未钉 patchReload startup（live 监听强依赖 HMR，legacy 装法必崩）')
  const locksSrc = readFileSync(join(root, 'src/host-node/profile-locks.ts'), 'utf8')
  for (const v of matrixLegacy) {
    if (!new RegExp(`'${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':`).test(locksSrc)) failures.push(`src/host-node/profile-locks.ts: 矩阵 legacy 行 ${v} 缺锁文件（^ 区间漂移回归点）`)
  }
  if (!locksSrc.includes('node_modules/@deepseek-ai/cordis-plugin-group')) failures.push('src/host-node/profile-locks.ts: 锁内缺 cordis-plugin-group（显式 peer 未进锁）')
  // 前端 import 完整性 canary（2026-09-22 事故）：nodes.js 用到
  // versionOptionsHtml 但漏导入 → 页面卡「加载中」且无测试可拦（DOM 文件
  // 不可单测导入）。至少守住这一个已知回归点。
  const nodesJs = readFileSync(join(root, 'public/assets/nodes.js'), 'utf8')
  if (nodesJs.includes('versionOptionsHtml(') && !nodesJs.includes('versionOptionsHtml }')) {
    failures.push('public/assets/nodes.js: 使用了 versionOptionsHtml 但未导入（前端 ReferenceError 回归点）')
  }
  if (nodesJs.includes('${guiBits}') && !nodesJs.includes('const guiBits')) {
    failures.push('public/assets/nodes.js: nodeRow 引用了 guiBits 但无定义（前端 ReferenceError 回归点）')
  }
  // 舰队 M3-1：ops 第三档沙箱三件套守卫（schema 档位 / 向导选项 / 黄字确认）
  const nodesHtml = readFileSync(join(root, 'public/pages/nodes.html'), 'utf8')
  if (!nodesHtml.includes('value="danger-full-access"')) {
    failures.push('public/pages/nodes.html: 向导沙箱下拉缺 danger-full-access 档位（M3-1 ops 节点）')
  }
  if (!/danger-full-access/.test(readFileSync(join(root, 'src/routes/provision.ts'), 'utf8'))) {
    failures.push('src/routes/provision.ts: provisionBody 沙箱 schema 缺 danger-full-access 档位')
  }
  // P0 配置迁移链守卫（hive/plan-config-version-switch）：CONFIG_MIGRATIONS
  // 必须覆盖 0..CURRENT_CONFIG_VERSION 连续 +1 升链——升级自动迁移的前提；
  // 删/断链 = CI 红。
  const migrationsSrc = readFileSync(join(root, 'src/config/migrations.ts'), 'utf8')
  const currentMatch = /CURRENT_CONFIG_VERSION = (\d+)/.exec(migrationsSrc)
  if (currentMatch === null) {
    failures.push('src/config/migrations.ts: 缺 CURRENT_CONFIG_VERSION 声明（配置迁移链守卫）')
  } else {
    const current = Number(currentMatch[1])
    const steps = [...migrationsSrc.matchAll(/\{ from: (\d+), to: (\d+),/g)]
    const covered = new Set(steps.map((m) => m[1]))
    for (let v = 0; v < current; v += 1) {
      if (!covered.has(String(v))) failures.push(`src/config/migrations.ts: 迁移链缺 ${v} → ${v + 1}（CURRENT_CONFIG_VERSION=${current}）`)
    }
    for (const m of steps) {
      if (Number(m[2]) !== Number(m[1]) + 1) failures.push(`src/config/migrations.ts: 迁移 {from:${m[1]},to:${m[2]}} 必须是 +1 升链`)
      if (Number(m[1]) >= current) failures.push(`src/config/migrations.ts: 迁移 {from:${m[1]},to:${m[2]}} 起点不在 0..${current - 1} 范围`)
    }
  }

  // CSRF cookie 名一致性守卫（为更名/重命名而设）：compose-e2e 在登录流程里
  // 硬编码了这个 cookie 名，源码里改名而脚本没跟上 = CI 的 compose-e2e 在登录
  // 步骤挂掉，且症状（401/无 CSRF）离真因很远。
  const csrfName = /export const CSRF_COOKIE = '([^']+)'/.exec(readFileSync(join(root, 'src/routes/auth.ts'), 'utf8'))?.[1]
  if (csrfName === undefined) {
    failures.push('src/routes/auth.ts: 缺 CSRF_COOKIE 声明（compose-e2e 依赖它）')
  } else if (!readFileSync(join(root, 'scripts/compose-e2e.mjs'), 'utf8').includes(`startsWith('${csrfName}=')`)) {
    failures.push(`scripts/compose-e2e.mjs: CSRF cookie 名与该常量（${csrfName}）不一致——compose-e2e 会在登录步骤失败`)
  }
} catch (error) {
  failures.push(`钉版同步守卫失败: ${error instanceof Error ? error.message : String(error)}`)
}

if (failures.length > 0) {
  console.error('check-docs FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('check-docs: OK（README 无死链、无手写测试数、部署文件完整、钉版与矩阵一致）')
