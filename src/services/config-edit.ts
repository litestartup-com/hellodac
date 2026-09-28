/**
 * Editing the outward-service declaration from the admin UI.
 *
 * The truth source stays `manager.config.yaml` (AGENTS A-1) -- this module does not introduce a second
 * one. What it adds is the missing middle between "hand-edit YAML and restart" and "a wizard": a
 * **validated** write, where the validation is the same one boot performs.
 *
 * Why validation re-loads the config instead of re-checking rules here: the service rules are not one
 * rule but a web of them (members must be public agents; one process per agent; one service per
 * machine; `count` must equal the listed workers today; `pin` needs machines; outward agents need a
 * pinned, priced model). A second copy of that web would drift from `loadConfig` and start rejecting
 * configs the manager happily boots, or accepting ones it refuses. So the candidate is written to a
 * sibling temp file and put through `loadConfig` itself; whatever it complains about is what the
 * operator sees, in its own words.
 *
 * The write path is `mutateYamlFile` with `validate: 'full'`: comments are preserved, the write is
 * atomic, and a config the manager would refuse to boot never stays in the truth source.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument, stringify, type Document } from 'yaml'
import { loadConfig, type AppConfig, type ResolvedService } from '../config.js'
import { mutateYamlFile, withConfigLock } from '../config-store.js'

/** A service declaration as the editor writes it (snake_case = the file's own spelling). */
export interface ServiceDraft {
  id: string
  label: string
  workers: string[]
  surfaces: Array<'tasks' | 'conversations'>
  permission: 'read' | 'write'
  session_idle_hours: number
  placement: 'spread' | 'pack' | 'pin'
  machines: string[]
  max_agents_per_machine: number
  capacity: { max_sessions_per_agent: number }
  knowledge: Array<{ host: string; mount: string; read_only: boolean }>
  /**
   * Placement watermarks the editor does not expose. They must still round-trip: editing a service
   * whose declaration carries them must write them back unchanged -- dropping them would silently
   * change the placement rules (real incident: a no-op apply on production removed thresholds:).
   */
  thresholds?: { min_free_cpu_percent?: number; min_free_mem_bytes?: number; min_free_disk_bytes?: number }
}

/** One agent that could serve a service, with the reason it may not. */
export interface WorkerCandidate {
  id: string
  name: string
  public: boolean
  /** Already serving another service (a machine may serve only one service). */
  serviceId: string | null
  endpoint: string
  machine: string
  provider: string | null
  model: string | null
  /** Whether the model is priced -- an unpriced outward agent is a permanent hole in the ledger. */
  priced: boolean
  /** Non-empty = this agent cannot be picked, and this is why (shown next to the disabled row). */
  blockedReason: string | null
}

export interface ServiceEditorContext {
  /** Hash of the config file the UI is looking at: applying against a changed file is refused. */
  configHash: string
  /** The declarations as they are on disk (not the resolved form: the editor round-trips these). */
  services: ServiceDraft[]
  workers: WorkerCandidate[]
  /** Machine ids that already host outward agents, and which service they serve. */
  machines: Array<{ id: string; hostname: string | null; services: string[]; outwardAgents: number }>
}

export interface ServicePreview {
  ok: boolean
  /** The rendered file with this declaration merged in (the operator sees exactly what would be written). */
  yaml: string
  /** Only the lines this change adds or removes. */
  diff: Array<{ kind: 'add' | 'remove'; text: string }>
  /** What the loader says about the candidate -- the operator's wording, not a re-implementation's. */
  errors: string[]
  /** Loader warnings (e.g. an unpinned model on an inward agent) worth showing before applying. */
  warnings: string[]
  /** The resolved service as the manager would hold it, for a "this is what you get" summary. */
  resolved: ResolvedService | null
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** The declaration currently on disk for one service id, shaped like the editor's draft. */
const draftOf = (raw: Record<string, unknown>): ServiceDraft => {
  const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {})
  const capacity = rec(raw['capacity'])
  const knowledge = Array.isArray(raw['knowledge']) ? raw['knowledge'] : []
  return {
    id: String(raw['id'] ?? ''),
    label: String(raw['label'] ?? ''),
    workers: Array.isArray(raw['workers']) ? raw['workers'].map(String) : [],
    surfaces: (Array.isArray(raw['surfaces']) ? raw['surfaces'] : ['tasks', 'conversations']).map(String) as ServiceDraft['surfaces'],
    permission: raw['permission'] === 'write' ? 'write' : 'read',
    session_idle_hours: typeof raw['session_idle_hours'] === 'number' ? raw['session_idle_hours'] : 24,
    placement: raw['placement'] === 'pack' || raw['placement'] === 'pin' ? raw['placement'] : 'spread',
    machines: Array.isArray(raw['machines']) ? raw['machines'].map(String) : [],
    max_agents_per_machine: typeof raw['max_agents_per_machine'] === 'number' ? raw['max_agents_per_machine'] : 4,
    capacity: { max_sessions_per_agent: typeof capacity['max_sessions_per_agent'] === 'number' ? capacity['max_sessions_per_agent'] : 4 },
    // The editor has no thresholds field, but the declaration may carry one: keep it so an edit
    // writes it back instead of dropping it (see ServiceDraft.thresholds).
    ...(typeof raw['thresholds'] === 'object' && raw['thresholds'] !== null
      ? { thresholds: raw['thresholds'] as NonNullable<ServiceDraft['thresholds']> }
      : {}),
    knowledge: knowledge.map((k) => {
      const row = rec(k)
      return { host: String(row['host'] ?? ''), mount: String(row['mount'] ?? ''), read_only: row['read_only'] !== false }
    }),
  }
}

/** The raw `services:` array (or [] when the section is absent). */
const rawServices = (configPath: string): Record<string, unknown>[] => {
  const doc = parseDocument(readFileSync(configPath, 'utf8'))
  const value = doc.toJS() as Record<string, unknown> | null
  const list = value?.['services']
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : []
}

/**
 * Everything the editor needs to render itself honestly: the declarations, who could serve them, and
 * why an agent could not. The "why not" matters as much as the "who" -- a disabled row with no reason
 * is the kind of dead end this whole pass exists to remove.
 */
export const serviceEditorContext = (deps: { config: AppConfig; configPath: string }): ServiceEditorContext => {
  const { config, configPath } = deps
  const serviceOf = new Map<string, string>()
  for (const service of config.services ?? []) for (const worker of service.workers) serviceOf.set(worker, service.id)
  const priced = new Set(Object.keys(config.pricing.rates))

  const workers: WorkerCandidate[] = Object.values(config.agents)
    .filter((agent) => agent.public)
    .map((agent) => {
      const machine = machineOf(config, agent.endpoint)
      const thisService = serviceOf.get(agent.id) ?? null
      const otherService = (config.services ?? []).find((s) => s.workers.includes(agent.id))
      const pinned = agent.provider !== null && agent.model !== null
      const modelPriced = agent.model !== null && priced.has(agent.model)
      const blockedReason = !pinned
        ? 'no model pin'
        : !modelPriced
          ? `no rate for ${agent.model}`
          : thisService !== null
            ? `already serves ${otherService?.id ?? thisService}`
            : null
      return {
        id: agent.id,
        name: agent.name,
        public: true,
        serviceId: thisService,
        endpoint: agent.endpoint,
        machine,
        provider: agent.provider,
        model: agent.model,
        priced: modelPriced,
        blockedReason,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  const byMachine = new Map<string, { id: string; hostname: string | null; services: string[]; outwardAgents: number }>()
  for (const worker of workers) {
    const entry = byMachine.get(worker.machine) ?? { id: worker.machine, hostname: null, services: [], outwardAgents: 0 }
    entry.outwardAgents += 1
    if (worker.serviceId !== null && !entry.services.includes(worker.serviceId)) entry.services.push(worker.serviceId)
    byMachine.set(worker.machine, entry)
  }

  return {
    configHash: hashOf(readFileSync(configPath, 'utf8')),
    services: rawServices(configPath).map(draftOf),
    workers,
    machines: [...byMachine.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

const machineOf = (config: AppConfig, endpointId: string): string => {
  const endpoint = config.endpoints[endpointId]
  return endpoint?.spawn?.host ?? 'local'
}

/** The `services:` entry a draft becomes (the file's own spelling; `count` follows the list). */
export const serviceEntryOf = (draft: ServiceDraft): Record<string, unknown> => ({
  id: draft.id,
  label: draft.label,
  workers: [...draft.workers],
  // §8.2 today: the agent source is 'list them all'. `count` is therefore the length, and the form
  // does not pretend otherwise -- auto-provisioning does not exist yet.
  count: draft.workers.length,
  surfaces: [...draft.surfaces],
  capacity: { max_sessions_per_agent: draft.capacity.max_sessions_per_agent },
  permission: draft.permission,
  session_idle_hours: draft.session_idle_hours,
  placement: draft.placement,
  ...(draft.placement === 'pin' ? { machines: [...draft.machines] } : {}),
  max_agents_per_machine: draft.max_agents_per_machine,
  ...(draft.thresholds === undefined ? {} : { thresholds: draft.thresholds }),
  ...(draft.knowledge.length === 0
    ? {}
    : { knowledge: draft.knowledge.map((k) => ({ host: k.host, mount: k.mount, read_only: k.read_only })) }),
})

/** Merge one declaration into the `services:` list (replace by id, else append, creating the section if needed). */
const mergeInto = (doc: Document, entry: Record<string, unknown>): void => {
  if (!doc.has('services')) {
    doc.set('services', [entry])
    return
  }
  // The parsed node is a YAML sequence, not a JS array: walk its items and read the id through the
  // scalar accessor (getIn), because comparing YAML nodes against a string never matches.
  const seq = doc.get('services')
  const items = seq !== null && typeof seq === 'object' && Array.isArray((seq as { items?: unknown }).items)
    ? ((seq as { items: unknown[] }).items)
    : []
  for (let i = 0; i < items.length; i += 1) {
    if (doc.getIn(['services', i, 'id']) === entry['id']) {
      doc.setIn(['services', i], entry)
      return
    }
  }
  doc.addIn(['services'], entry)
}

/**
 * Fields the editor does not expose (`thresholds`) must survive an edit even when the caller's draft
 * does not carry them: the write layer never drops data it does not understand. The round trip through
 * the UI already carries them; this is the second net for direct callers.
 */
const entryOf = (configPath: string, draft: ServiceDraft): Record<string, unknown> => {
  const entry = serviceEntryOf(draft)
  if (entry['thresholds'] !== undefined) return entry
  const onDisk = parseDocument(readFileSync(configPath, 'utf8'))
  const seq = onDisk.get('services')
  const items = seq !== null && typeof seq === 'object' && Array.isArray((seq as { items?: unknown }).items)
    ? ((seq as { items: unknown[] }).items)
    : []
  for (let i = 0; i < items.length; i += 1) {
    if (onDisk.getIn(['services', i, 'id']) !== draft.id) continue
    const existing = onDisk.getIn(['services', i, 'thresholds'])
    if (existing !== undefined && existing !== null) entry['thresholds'] = existing
    break
  }
  return entry
}

/** A minimal line diff (enough to show an operator what is about to be written). */
const lineDiff = (before: string, after: string): Array<{ kind: 'add' | 'remove'; text: string }> => {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const beforeSet = new Set(beforeLines)
  const afterSet = new Set(afterLines)
  const out: Array<{ kind: 'add' | 'remove'; text: string }> = []
  for (const line of beforeLines) if (!afterSet.has(line) && line.trim() !== '') out.push({ kind: 'remove', text: line })
  for (const line of afterLines) if (!beforeSet.has(line) && line.trim() !== '') out.push({ kind: 'add', text: line })
  return out
}

/**
 * Render + validate a candidate **without touching the truth source**: the candidate goes to a temp
 * file in the same directory and through the real loader, so the answer is the boot answer.
 */
export const previewService = (deps: { config: AppConfig; configPath: string; draft: ServiceDraft }): ServicePreview => {
  const { config, configPath, draft } = deps
  const before = readFileSync(configPath, 'utf8')
  const doc = parseDocument(before)
  if (doc.errors.length > 0) {
    return {
      ok: false,
      yaml: before,
      diff: [],
      errors: [`the config file on disk has YAML syntax errors: ${doc.errors.map((e) => e.message).join('; ')}`],
      warnings: [],
      resolved: null,
    }
  }
  mergeInto(doc, entryOf(configPath, draft))
  const next = stringify(doc, { lineWidth: 0 })

  const dir = mkdtempSync(join(tmpdir(), 'dac-service-preview-'))
  let errors: string[] = []
  let warnings: string[] = []
  let resolved: ResolvedService | null = null
  try {
    const candidate = join(dir, 'manager.config.yaml')
    writeFileSync(candidate, next, 'utf8')
    try {
      const loaded = loadConfig(candidate)
      warnings = loaded.warnings
      resolved = (loaded.services ?? []).find((service) => service.id === draft.id) ?? null
    } catch (error) {
      errors = [(error as Error).message]
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  void config

  return { ok: errors.length === 0, yaml: next, diff: lineDiff(before, next), errors, warnings, resolved }
}

export interface ApplyResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  resolved: ResolvedService | null
  /** False = the file did not change (the declaration was already identical). */
  changed: boolean
}

/**
 * Write the declaration for real. The write is atomic, comment-preserving and rolled back by the
 * loader's own verdict (see `mutateYamlFile`), and the in-memory config is hot-swapped to the resolved
 * form so the pages and the dispatcher agree with disk without waiting for a restart.
 *
 * `expectHash`: the hash the operator was looking at. A mismatch means somebody else changed the file
 * between preview and apply -- refuse rather than silently merge over their edit.
 */
export const applyService = async (deps: {
  config: AppConfig
  configPath: string
  draft: ServiceDraft
  expectHash?: string
}): Promise<ApplyResult> => {
  const { config, configPath, draft } = deps
  return await withConfigLock(() => {
    if (deps.expectHash !== undefined && deps.expectHash !== hashOf(readFileSync(configPath, 'utf8'))) {
      return {
        ok: false,
        errors: ['the config file changed on disk since this form was opened; reload before applying so you do not overwrite that edit'],
        warnings: [],
        resolved: null,
        changed: false,
      }
    }

    const before = readFileSync(configPath, 'utf8')
    let resolved: ResolvedService | null = null
    mutateYamlFile(
      configPath,
      (doc) => { mergeInto(doc, entryOf(configPath, draft)) },
      { validate: 'full' },
    )
    // `validate: 'full'` already ran loadConfig and rolled back on failure, so reaching here means the
    // file boots. Read the resolved service back out of a fresh load for the hot-swap below.
    const loaded = loadConfig(configPath)
    resolved = (loaded.services ?? []).find((service) => service.id === draft.id) ?? null
    if (resolved === null) {
      return { ok: false, errors: [`the service "${draft.id}" did not survive the write`], warnings: [], resolved: null, changed: false }
    }

    // Hot swap: the same shape provision uses on a node change. Mirrored into the DB by the caller
    // (reconcile), so the registry and the config keep one story.
    config.services = loaded.services ?? []
    // Membership decides whether an agent is outward-facing; the file is the truth for that too.
    for (const [id, agent] of Object.entries(loaded.agents)) {
      const target = config.agents[id]
      if (target !== undefined) target.public = agent.public
    }

    return {
      ok: true,
      errors: [],
      warnings: loaded.warnings,
      resolved,
      changed: readFileSync(configPath, 'utf8') !== before,
    }
  })
}
