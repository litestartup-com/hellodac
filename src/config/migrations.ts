/**
 * P0 (hive/plan-config-version-switch): versioned config migration -- upgrades with no hand edits.
 *
 * The discipline: whenever a release changes the structure of manager.config.yaml (a new field, a
 * rename, a meaning change), bump CURRENT_CONFIG_VERSION and hang a `from -> to` chain migration in
 * CONFIG_MIGRATIONS; boot (loadConfig) translates an old config into the new structure automatically.
 *
 * - an old config (no config_version) = version 0;
 * - a version > CURRENT = a config from a newer manager, refused fail-loud (telling the user to upgrade);
 * - a broken chain (a missing step) = refuse to start fail-loud, never run a half-migrated config;
 * - before writing back, the original is backed up as `<config>.pre-mig.bak` (once only, never over an older one);
 * - writing back = re-serialising the YAML, so comments in the file are lost (migrations are rare; the backup covers it).
 *
 * check-docs.mjs permanently asserts that the chain covers 0..CURRENT, one step at a time (breaking it turns CI red).
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
  // 0 -> 1: the version field is born -- an old config has no config_version, so it gets one; this is
  // the migration mechanism's first real slot (a placeholder: the structure stands, only the stamp lands).
  { from: 0, to: 1, up: (doc) => ({ config_version: 1, ...doc }) },
]

/** The document's config version: absent/invalid = 0 (an old config). */
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
  /** A human-readable note for when the migration happens (goes to config.warnings, visible in the boot log). */
  warnings: string[]
}

/**
 * Migrate and write the config file back when needed. version === CURRENT has zero side effects (no write, no backup).
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
