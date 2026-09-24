/**
 * 能力一（2026-09-20）：宿主机节点的 profile 生成 / 安装 / 钥匙 / 依赖命令——
 * 从 src/cli/setup.ts 抽出的公共模块（setup 与 provision 共用，行为不变的搬家 +
 * 一处能力变化：profile 依赖新增 `@deepseek-ai/dsh` 自身，隔离安装后 spawn 不再
 * 依赖全局 dsh）。
 *
 * 布局：`<nodesHome>/<name>/profiles/<name>/` 下 package.json（bundles + gateway
 * + dsh 自身，全部钉版）+ cordis.patch.yml（webserver 只绑回环 + 节点端口）+
 * pnpm-workspace.yaml（npm 安装时的构建脚本白名单兼容件）。
 */
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { COMPAT_DSH_VERSION, GATEWAY_PACKAGE, GATEWAY_REF, resolvePair } from '../dsh-version.js'
import { PROFILE_LOCKS } from './profile-locks.js'

export interface ProfileSpec {
  name: string
  port: number
}

// 蜂群2计划 P1：bundle 钉版本（= COMPAT_DSH_VERSION），根治裸机安装漂移；
// gateway 既是 bundle 又是依赖，引用由 gatewayDep 决定（默认钉 commit）。
export const PROFILE_BUNDLES: Record<string, string> = {
  '@deepseek-ai/dsh-base': COMPAT_DSH_VERSION,
  '@deepseek-ai/dsh-web-app': COMPAT_DSH_VERSION,
}

/** 能力一：隔离安装的 profile 依赖 = dsh 自身 + bundles + gateway（全部钉版）。
 * 能力二修正（2026-09-22 舰队 M1-6 揪出）：bundles 必须钉**目标** dshVersion——
 * 旧实现展开 PROFILE_BUNDLES（恒 COMPAT_DSH_VERSION）把传入版本盖掉，0.1.5
 * 节点会拿到 0.1.2 bundles（Windows 崩溃事故的配对形态，事实卡 §13）。 */
/**
 * 能力四（舰队 M1 试点实证，2026-09-23，事实卡 dsh-facts §14）：
 * --legacy-peer-deps 会跳过全部 peer，而 0.1.5 家族的 dsh-app-boot 静态导入
 * @deepseek-ai/cordis-plugin-group、23 个旧家族名包只存在于 peer 区间——
 * 显式补为直接依赖（钉实证版本），否则新装节点启动即崩。与锁文件
 * （profile-locks.ts）配套：锁钉整树快照，本表补上锁内缺失的 peer。
 * 与 gen-node-profile.mjs 的清单同步（check-docs.mjs 常驻断言）。
 */
export const LEGACY_PEER_PINS: Record<string, Record<string, string>> = {
  '0.1.5-rc.2': {
    '@deepseek-ai/cordis-plugin-group': '1.0.2',
    '@deepseek-ai/cordis-plugin-hmr': '1.0.17',
    '@deepseek-ai/cordis-plugin-include': '1.0.7',
    '@deepseek-ai/dsh-anonymous-user-id': '0.1.5-rc.3',
    '@deepseek-ai/dsh-attachment': '0.1.5-rc.3',
    '@deepseek-ai/dsh-authorization': '0.1.5-rc.3',
    '@deepseek-ai/dsh-bash-local': '0.1.5-rc.3',
    '@deepseek-ai/dsh-code-runtime': '0.1.5-rc.3',
    '@deepseek-ai/dsh-compaction': '0.1.5-rc.3',
    '@deepseek-ai/dsh-fs': '0.1.5-rc.3',
    '@deepseek-ai/dsh-hook-protocol': '0.1.5-rc.3',
    '@deepseek-ai/dsh-jobs': '0.1.5-rc.3',
    '@deepseek-ai/dsh-output-retention': '0.1.5-rc.3',
    '@deepseek-ai/dsh-sandbox': '0.1.5-rc.3',
    '@deepseek-ai/dsh-sdk-protocol': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-persistence': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-query': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-telemetry': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-title-llm': '0.1.5-rc.3',
    '@deepseek-ai/dsh-settings': '0.1.5-rc.3',
    '@deepseek-ai/dsh-shell': '0.1.5-rc.3',
    '@deepseek-ai/dsh-spill': '0.1.5-rc.3',
    '@deepseek-ai/dsh-subagent-in-process-driver': '0.1.5-rc.3',
    '@deepseek-ai/dsh-util-time': '0.1.5-rc.3',
    '@deepseek-ai/dsh-util-workspace-path': '0.1.5-rc.3',
    '@deepseek-ai/dsh-workflow': '0.1.5-rc.3',
  },
}

export const profileDependencies = (
  dshVersion: string = COMPAT_DSH_VERSION,
  gatewayDep: string = GATEWAY_REF,
): Record<string, string> => ({
  '@deepseek-ai/dsh': dshVersion,
  '@deepseek-ai/dsh-base': dshVersion,
  '@deepseek-ai/dsh-web-app': dshVersion,
  [GATEWAY_PACKAGE]: gatewayDep,
  ...(LEGACY_PEER_PINS[dshVersion] ?? {}),
})

export const profileFiles = (
  spec: ProfileSpec,
  gatewayDep: string,
  dshVersion: string = COMPAT_DSH_VERSION,
  /** webserver 绑定地址：裸机默认 127.0.0.1（GUI 红线）；agent 远端节点用
   * 0.0.0.0（manager 从远端探活；安全靠 Q5 防火墙白名单 + 0.1.5 token）。 */
  bindHost: string = '127.0.0.1',
): Record<string, string> => {
  const pkg = {
    name: `dsh-profile-${spec.name}`,
    private: true,
    dsh: {
      profile: {
        bundles: [...Object.keys(PROFILE_BUNDLES), GATEWAY_PACKAGE],
        // M1 试点实证：缺省 live patch 监听强依赖 HMR 服务（legacy 装法下
        // cordis-plugin-hmr 是 peer，不显式补必崩）——节点由 manager 托管，
        // 不需要热监听，钉 startup（补丁在启动时生效即可）。
        patchReload: 'startup',
      },
    },
    dependencies: profileDependencies(dshVersion, gatewayDep),
  }
  const patch = [
    {
      id: 'webserver',
      config: {
        // 整行 config 替换（无深度合并，README 原话）：节点永远只绑回环。
        host: bindHost,
        port: spec.port,
      },
    },
  ]
  return {
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    // M1 试点实证：随送锁文件钉住整树快照（^ 区间会漂到 rc.3，registry next 已发）
    ...(PROFILE_LOCKS[dshVersion] === undefined ? {} : { 'package-lock.json': PROFILE_LOCKS[dshVersion] }),
    // pnpm ≥10 默认拒绝运行依赖构建脚本（ERR_PNPM_IGNORED_BUILDS，实测容器构建撞过）——
    // 显式批准 DSH 依赖链里必须构建的原生/后置脚本包。10 认顶层键、11 认 pnpm 嵌套键，
    // 两个形态都给（9 及以下直接忽略，按旧语义照跑）。
    'pnpm-workspace.yaml': [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      'onlyBuiltDependencies:',
      "  - '@deepseek-ai/dsh-subprocess-local'",
      "  - '@google/genai'",
      '  - koffi',
      '  - node-pty',
      '  - protobufjs',
      'pnpm:',
      '  onlyBuiltDependencies:',
      "    - '@deepseek-ai/dsh-subprocess-local'",
      "    - '@google/genai'",
      '    - koffi',
      '    - node-pty',
      '    - protobufjs',
      '',
    ].join('\n'),
    'cordis.yml': '# dsh profile root — empty entry list; edit cordis.patch.yml\n[]\n',
    'cordis.patch.yml': stringifyYaml(patch),
  }
}

/**
 * 在 nodesHome 下为每个节点生成独立 DSH_HOME（<nodesHome>/<name>/profiles/<name>）。
 * 节点目录已存在则不动。
 */
export const ensureNodeProfiles = (nodesHome: string, specs: ProfileSpec[], gatewayDep: string, dshVersion: string = COMPAT_DSH_VERSION): string[] => {
  mkdirSync(nodesHome, { recursive: true })
  const created: string[] = []
  for (const spec of specs) {
    const nodeHome = join(nodesHome, spec.name)
    const dir = join(nodeHome, 'profiles', spec.name)
    if (existsSync(dir)) continue
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(profileFiles(spec, gatewayDep, dshVersion))) {
      writeFileSync(join(dir, name), content, 'utf8')
    }
    // 能力二：播种版本标记（容器 entrypoint 同款）——boot 对账/align 据此判定
    // 版本/ref 漂移；存量老 profile（无标记）视同漂移，一键对齐入口兜底。
    writeFileSync(join(dir, '.seed-version'), profileSeed(dshVersion, gatewayDep) + '\n', 'utf8')
    created.push(nodeHome)
  }
  return created
}

/** 能力二：profile 的版本种子 = sha1(dshVersion|gatewayRef)，容器 entrypoint 同款。 */
export const profileSeed = (dshVersion: string, gatewayRef: string): string =>
  createHash('sha1').update(`${dshVersion}|${gatewayRef}`).digest('hex')

/** 读 profile 目录的 .seed-version 标记；不存在 = null（存量老 profile）。 */
export const currentProfileSeed = (profileDir: string): string | null => {
  try {
    return readFileSync(join(profileDir, '.seed-version'), 'utf8').trim()
  } catch {
    return null
  }
}

/** 漂移判定：标记缺失或与期望种子不一致 = 需要重播种对齐。 */
export const profileDrift = (profileDir: string, dshVersion: string, gatewayRef: string): boolean =>
  currentProfileSeed(profileDir) !== profileSeed(dshVersion, gatewayRef)

/** 能力二：无条件重播种 profile（对齐路由用——版本切换/漂移收敛，幂等）。 */
export const reseedProfile = (profileDir: string, spec: ProfileSpec, gatewayDep: string, dshVersion: string = COMPAT_DSH_VERSION): void => {
  mkdirSync(profileDir, { recursive: true })
  for (const [name, content] of Object.entries(profileFiles(spec, gatewayDep, dshVersion))) {
    writeFileSync(join(profileDir, name), content, 'utf8')
  }
  writeFileSync(join(profileDir, '.seed-version'), profileSeed(dshVersion, gatewayDep) + '\n', 'utf8')
}

/** 把主 DSH_HOME 的模型凭据复制进节点目录（同一用户同一把 key，缺省不覆盖）。 */
export const ensureNodeCredentials = (mainDshHome: string, nodeHome: string): boolean => {
  const source = join(mainDshHome, '.credentials.yaml')
  const target = join(nodeHome, '.credentials.yaml')
  if (!existsSync(source) || existsSync(target)) return false
  mkdirSync(nodeHome, { recursive: true })
  writeFileSync(target, readFileSync(source, 'utf8'), 'utf8')
  return true
}

/**
 * 节点 profile 依赖安装命令。0.1.2 切主路实测（容器路径同款结论）：
 * pnpm@9 对 harness 0.1.2-rc.1 的内层预发布区间解析失败、pnpm@11 的
 * onlyBuiltDependencies 白名单失效——改用 npm（同版本集实证可解析，且按
 * 旧语义跑原生构建脚本）。Windows：npm 是 .cmd 垫片，调用处必须 shell: true。
 *
 * 能力二：目标版本在矩阵里标 needsLegacyPeerDeps 的配对追加
 * `--legacy-peer-deps`（0.1.5 实测 ERESOLVE——facade peer 区间 ^0.1.2-rc.1
 * 覆盖不到 0.1.5 宿主树，事实卡 dsh-facts §12）。
 */
export const profileInstallCommand = (_platform: NodeJS.Platform, dshVersion: string = COMPAT_DSH_VERSION): { cmd: string; args: string[] } => {
  const args = ['install', '--no-audit', '--no-fund']
  if (resolvePair(dshVersion)?.needsLegacyPeerDeps === true) args.push('--legacy-peer-deps')
  return { cmd: 'npm', args }
}

/**
 * 能力一：节点 profile 内隔离安装的 dsh bin（@deepseek-ai/dsh 的 bin 入口
 * = lib/bin.js，0.1.2 包实测）。未安装返回 null——调用方回退全局 dsh
 * （存量节点兼容路径）。
 */
export const dshBinInProfile = (profileDir: string): string | null => {
  const candidate = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(candidate) ? candidate : null
}

/**
 * 解析 gateway 密钥：优先 settings.yaml 里 facade 命名空间的 provisionedKey；
 * 没有则生成一个并追加到 apiKeys（gateway 的静态密钥数组，settings live 生效）。
 * 命名空间 = GATEWAY_PACKAGE（0.1.2 切主路起 ohdsh-api-facade；旧 dsh-api-gw
 * 段的钥匙不会被新 facade 读取——容器路径同款坑，别再踩）。
 */
export const resolveGatewayKey = (dshHome: string, settingsPath: string | null): string => {
  const ns = GATEWAY_PACKAGE
  const path = settingsPath ?? join(dshHome, 'settings.yaml')
  if (existsSync(path)) {
    const parsed = parseYaml(readFileSync(path, 'utf8')) as Record<string, { provisionedKey?: string; apiKeys?: string[] } | undefined>
    const section = parsed[ns]
    if (typeof section?.provisionedKey === 'string' && section.provisionedKey !== '') return section.provisionedKey
    const keys = Array.isArray(section?.apiKeys) ? section.apiKeys.filter((k) => k !== '') : []
    const first = keys[0]
    if (first !== undefined) return first
  }
  const minted = 'apigw-' + randomBytes(24).toString('hex')
  const parsed = existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
  const section = (parsed[ns] ?? {}) as Record<string, unknown>
  const apiKeys = Array.isArray(section.apiKeys) ? [...section.apiKeys, minted] : [minted]
  parsed[ns] = { ...section, apiKeys }
  writeFileSync(path, stringifyYaml(parsed), 'utf8')
  return minted
}
