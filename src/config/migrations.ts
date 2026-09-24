/**
 * P0（hive/plan-config-version-switch）：配置版本化迁移——升级零手改配置。
 *
 * 纪律：每次发布改了 manager.config.yaml 的结构（新字段/改名/改语义）就
 * bump CURRENT_CONFIG_VERSION 并在 CONFIG_MIGRATIONS 里挂一条 `from → to`
 * 升链迁移；boot（loadConfig）自动把旧配置翻译成新结构。
 *
 * - 旧配置（无 config_version）= 版本 0；
 * - 版本 > CURRENT = 来自更新的 manager 生成的配置，fail-loud 拒绝（提示升级）；
 * - 链断裂（缺某级迁移）= fail-loud 拒绝启动，绝不用半迁移的配置跑；
 * - 写回前原文件备份为 `<config>.pre-mig.bak`（只备份一次，不覆盖更早的原件）；
 * - 写回 = 重新序列化 YAML——文件里的注释会丢失（迁移是罕见事件，原样备份兜底）。
 *
 * check-docs.mjs 常驻断言迁移链覆盖 0..CURRENT 且逐级 +1（删坏 = CI 红）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stringify as stringifyYaml } from 'yaml'

export const CURRENT_CONFIG_VERSION = 1

export interface ConfigMigration {
  from: number
  to: number
  up: (doc: Record<string, unknown>) => Record<string, unknown>
}

export const CONFIG_MIGRATIONS: ConfigMigration[] = [
  // 0 → 1：版本字段诞生——旧配置没有 config_version，补上；这是迁移机制的
  // 首个真实迁移位（占位：结构不变，只盖版本戳）。
  { from: 0, to: 1, up: (doc) => ({ config_version: 1, ...doc }) },
]

/** 文档的配置版本：缺省/非法 = 0（老配置）。 */
const versionOf = (doc: unknown): number => {
  const v = (doc as { config_version?: unknown } | null)?.config_version
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
}

const applyChain = (doc: Record<string, unknown>, from: number): { doc: Record<string, unknown>; version: number } => {
  let current = doc
  let version = from
  while (version < CURRENT_CONFIG_VERSION) {
    const step = CONFIG_MIGRATIONS.find((m) => m.from === version)
    if (step === undefined) {
      throw new Error(`config migration chain is broken: no migration for ${version} → ${version + 1} (CURRENT_CONFIG_VERSION=${CURRENT_CONFIG_VERSION})`)
    }
    current = step.up(current)
    version = step.to
  }
  return { doc: current, version }
}

export interface MigrateResult {
  doc: Record<string, unknown>
  /** 迁移发生时的人类可读说明（进 config.warnings，boot 日志可见）。 */
  warnings: string[]
}

/**
 * 必要时迁移并写回配置文件。version === CURRENT 时零副作用（不写文件、不备份）。
 */
export const migrateConfigIfNeeded = (configPath: string, raw: unknown): MigrateResult => {
  const version = versionOf(raw)
  if (version > CURRENT_CONFIG_VERSION) {
    throw new Error(`config version ${version} is newer than the supported ${CURRENT_CONFIG_VERSION} — it was written by a newer manager; upgrade the manager first`)
  }
  if (version === CURRENT_CONFIG_VERSION) return { doc: raw as Record<string, unknown>, warnings: [] }

  const { doc, version: to } = applyChain(raw as Record<string, unknown>, version)
  const bak = `${configPath}.pre-mig.bak`
  const original = readFileSync(configPath, 'utf8')
  if (!existsSync(bak)) writeFileSync(bak, original, 'utf8')
  const tmp = `${configPath}.tmp`
  writeFileSync(tmp, stringifyYaml(doc), 'utf8')
  renameSync(tmp, configPath)
  return { doc, warnings: [`config migrated from version ${version} to ${to} (original backed up at ${bak}; comments are not preserved)`] }
}
