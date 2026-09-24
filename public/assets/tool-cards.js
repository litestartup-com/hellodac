// Tool-call card derivation, ported from DSH web's ui-tool GenericToolCard
// (dsh-client-ui-tool, 0.1.2-rc.1): tool name -> variant, variant title,
// summary / body / file path derived from the call arguments, and result text.
//
// 0.1.2 has no `view` field on session events (the old gateway's wire form is
// gone); DSH web derives the same cards client-side from the raw call/result
// events, so manager does the same here. Pure functions -- the HTML assembly
// lives in chat.js, tests live in tool-cards.test.mjs.

import { t, loadI18n } from './ui.js'

await loadI18n()

/** DSH's TOOL_VARIANTS table (name -> variant). */
export const TOOL_VARIANTS = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** DSH's TOOL_TITLES overrides (tool-owned titles refining the variant). */
export const TOOL_TITLES = {
  cordis_package_inspect: 'Inspect',
  cordis_runtime_inspect: 'Inspect',
  cordis_run: 'Run Cordis Plugin',
  cordis_stop: 'Stop Cordis Plugin',
  cordis_undefine: 'Remove Cordis Plugin',
  pwsh: 'Pwsh',
}

/** Variant display titles (DSH's Figma literals; manager UI is Chinese). */
export const VARIANT_TITLES = {
  search: t('tool.search'),
  read: t('tool.read'),
  bash: t('tool.bash'),
  write: t('tool.write'),
  edit: t('tool.edit'),
  code: t('tool.code'),
  others: t('tool.others'),
}

/** Summary key preference per variant (DSH's SUMMARY_KEYS). */
const SUMMARY_KEYS = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

const FILE_PATH_KEYS = ['path', 'file_path']
const FILE_PATH_VARIANTS = new Set(['read', 'write', 'edit'])

const firstLine = (text) => {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

const parseArgs = (raw) => {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const pickString = (args, keys) => {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Classify a tool name into its row variant; unknown names land on `others`. */
export const classifyTool = (name) => TOOL_VARIANTS[name] ?? 'others'

/** Display title for one call: tool-owned override first, then the variant title. */
export const toolTitle = (name) => {
  if (TOOL_TITLES[name] !== undefined) return TOOL_TITLES[name]
  return VARIANT_TITLES[classifyTool(name)]
}

/** One-line summary for the call, derived from its arguments (DSH deriveSummary). */
export const toolSummary = (name, argsRaw) => {
  const variant = classifyTool(name)
  const parsed = parseArgs(argsRaw)
  if (parsed === null) return firstLine(String(argsRaw ?? ''))
  if (variant === 'search' && Array.isArray(parsed.queries)) {
    const queries = parsed.queries.filter((query) => typeof query === 'string' && query !== '')
    if (queries.length > 0) return queries.map(firstLine).join(', ')
  }
  const picked = pickString(parsed, SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value !== '') return firstLine(value)
  }
  return firstLine(String(argsRaw ?? ''))
}

/** Workspace path for read/write/edit calls, or null (DSH deriveFilePath). */
export const toolFilePath = (name, argsRaw) => {
  const variant = classifyTool(name)
  if (!FILE_PATH_VARIANTS.has(variant)) return null
  const parsed = parseArgs(argsRaw)
  if (parsed === null) return null
  const picked = pickString(parsed, FILE_PATH_KEYS)
  return picked === undefined ? null : firstLine(picked)
}

/**
 * Body to show under the call head (DSH deriveBody): the code text for run_code,
 * pretty JSON for the rest, null when there is nothing worth folding.
 */
export const toolBody = (name, argsRaw) => {
  if (typeof argsRaw !== 'string' || argsRaw === '') return null
  const variant = classifyTool(name)
  const parsed = parseArgs(argsRaw)
  if (parsed === null) return argsRaw
  if (variant === 'code' && typeof parsed.code === 'string' && parsed.code !== '') return parsed.code
  return JSON.stringify(parsed, null, 2)
}
