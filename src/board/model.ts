import { z } from 'zod'

/**
 * The dashboard contract between an agent and manager.
 *
 * manager renders *block types*, never business fields. A personal agent tracks
 * holdings and a company agent tracks receivables; if manager knew about either
 * one, every new kind of card would mean changing manager's source. So the
 * layout lives in the workspace data and manager only supplies a catalogue of
 * ways to draw things.
 *
 * The catalogue below is not invented: each entry exists because a real board
 * needed it (KPI strip, target-vs-actual table, budget bars, weekly returns,
 * allocation pie, daily checklist...). Adding a new type is a deliberate act,
 * not something an agent can do by writing a file.
 */

/** Colour intent. Kept abstract so themes can change without touching data. */
export const TONES = ['good', 'warn', 'bad', 'info', 'muted'] as const
export type Tone = (typeof TONES)[number]

// These caps exist because the data is written by a language model. A runaway
// generation should degrade into a truncated card, not a browser that hangs or
// a response measured in megabytes.
const MAX_TEXT = 2_000
const MAX_ITEMS = 500
const MAX_BLOCKS = 60
const MAX_PAGES = 24
const MAX_COLUMNS = 12

const text = z.string().max(MAX_TEXT)
const shortText = z.string().max(200)
const tone = z.enum(TONES).optional()

const items = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(MAX_ITEMS)

/**
 * A table cell.
 *
 * Numbers and booleans are accepted and stringified. Writing `["08-30", 38]` is
 * the single most natural mistake an agent makes here, and rejecting it turns
 * the whole table into an error card over a value that was never ambiguous.
 * This is formatting, not guessing -- nothing is inferred that was not written.
 */
const cell = z
  .union([z.string(), z.number().finite(), z.boolean(), z.null()])
  .transform((v) => (v === null ? '' : String(v)))
  .pipe(z.string().max(200))

/** A headline number. `sub` is the small print under the value. */
const kpiBlock = z.object({
  type: z.literal('kpi'),
  title: shortText.optional(),
  items: items(z.object({ label: shortText, value: shortText, sub: shortText.optional(), tone })),
})

/** Current value against a target. */
const metricsBlock = z.object({
  type: z.literal('metrics'),
  title: shortText.optional(),
  items: items(z.object({ name: shortText, value: shortText, target: shortText.optional(), tone })),
})

/** Plans, memos, todos. `note` is the second line. */
const listBlock = z.object({
  type: z.literal('list'),
  title: shortText.optional(),
  items: items(z.object({ text, note: text.optional(), tag: shortText.optional(), tone })),
})

const tableBlock = z.object({
  type: z.literal('table'),
  title: shortText.optional(),
  columns: z.array(shortText).min(1).max(MAX_COLUMNS),
  rows: items(z.array(cell).max(MAX_COLUMNS)),
})

/** Budgets, completion rates. Drawn as a filled bar. */
const progressBlock = z.object({
  type: z.literal('progress'),
  title: shortText.optional(),
  items: items(
    z.object({
      label: shortText,
      value: z.number().finite(),
      max: z.number().finite().positive(),
      note: shortText.optional(),
      tone,
    }),
  ),
})

/**
 * A small bar chart. `null` means "not recorded" and draws a stub, which is not
 * the same as zero. Negative values are drawn in a different colour rather than
 * below an axis, so the sign is visible without a baseline to anchor to.
 */
const barsBlock = z.object({
  type: z.literal('bars'),
  title: shortText.optional(),
  items: items(z.object({ label: shortText, value: z.number().finite().nullable(), note: shortText.optional() })),
})

/** Composition. Values are weights; manager computes the percentages. */
const pieBlock = z.object({
  type: z.literal('pie'),
  title: shortText.optional(),
  items: items(z.object({ label: shortText, value: z.number().finite().nonnegative() })),
})

/**
 * Daily habits. `done` is what the agent last wrote; ticking a box in the
 * browser is a local convenience only, since the file is the source of truth.
 */
const checklistBlock = z.object({
  type: z.literal('checklist'),
  title: shortText.optional(),
  items: items(z.object({ text, done: z.boolean().default(false) })),
})

/** Rotates by day so the board is not identical every morning. */
const quoteBlock = z.object({
  type: z.literal('quote'),
  title: shortText.optional(),
  items: items(z.object({ text, source: shortText.optional() })),
})

/** Labelled clusters of one-liners: reading lists, hobbies, categories. */
const groupsBlock = z.object({
  type: z.literal('groups'),
  title: shortText.optional(),
  groups: items(z.object({ label: shortText, items: z.array(text).max(MAX_ITEMS) })),
})

/** Free prose. Escaped on render like everything else; markdown is not parsed. */
const noteBlock = z.object({
  type: z.literal('note'),
  title: shortText.optional(),
  text,
  tone,
})

export const blockSchema = z.discriminatedUnion('type', [
  kpiBlock,
  metricsBlock,
  listBlock,
  tableBlock,
  progressBlock,
  barsBlock,
  pieBlock,
  checklistBlock,
  quoteBlock,
  groupsBlock,
  noteBlock,
])

export type Block = z.infer<typeof blockSchema>
export const BLOCK_TYPES = [
  'kpi',
  'metrics',
  'list',
  'table',
  'progress',
  'bars',
  'pie',
  'checklist',
  'quote',
  'groups',
  'note',
] as const

/**
 * A block manager could not make sense of.
 *
 * Rendered as a visible placeholder rather than dropped. A silently missing card
 * is the worst outcome: the board looks fine and the number you needed is simply
 * absent. This way a bad write is obvious on the page and in the API response.
 */
export interface UnsupportedBlock {
  type: 'unsupported'
  title?: string
  reason: string
}

export type RenderableBlock = Block | UnsupportedBlock

export interface Page {
  key: string
  label: string
  order: number
  blocks: RenderableBlock[]
}

export interface BoardModel {
  title: string
  asOf: string | null
  pages: Page[]
  /** Everything manager had to reject, so the UI can surface it. */
  problems: BoardProblem[]
}

export interface BoardProblem {
  /** Source file, relative to the workspace. */
  file: string
  detail: string
}

export const metaSchema = z.object({
  title: shortText.optional(),
  asOf: shortText.nullable().optional(),
})

export const pageSchema = z.object({
  key: shortText.regex(/^[a-z0-9][a-z0-9-]*$/i, 'key must be alphanumeric or dashes').optional(),
  label: shortText,
  order: z.number().finite().optional(),
  blocks: z.array(z.unknown()).max(MAX_BLOCKS),
})

export const LIMITS = { MAX_TEXT, MAX_ITEMS, MAX_BLOCKS, MAX_PAGES, MAX_COLUMNS } as const

/**
 * Validates one block, degrading to a placeholder instead of failing the page.
 *
 * A single malformed card must not cost the user the other twenty on the page.
 */
export const parseBlock = (raw: unknown): { block: RenderableBlock; problem: string | null } => {
  const type = (raw as { type?: unknown } | null)?.type
  const title = (raw as { title?: unknown } | null)?.title
  const titleText = typeof title === 'string' ? title.slice(0, 200) : undefined
  // exactOptionalPropertyTypes: title 只在有值时出现,不传显式 undefined。
  const unsupported = (reason: string) => ({
    type: 'unsupported' as const,
    ...(titleText === undefined ? {} : { title: titleText }),
    reason,
  })

  if (typeof type !== 'string') {
    return {
      block: unsupported('block has no "type"'),
      problem: 'block has no "type"',
    }
  }

  if (!(BLOCK_TYPES as readonly string[]).includes(type)) {
    const reason = `unknown block type "${type}"; manager knows ${BLOCK_TYPES.join(', ')}`
    return { block: unsupported(reason), problem: reason }
  }

  const parsed = blockSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first === undefined ? '' : ` at ${first.path.join('.') || '(root)'}: ${first.message}`
    const reason = `"${type}" block is malformed${where}`
    return { block: unsupported(reason), problem: reason }
  }

  return { block: parsed.data, problem: null }
}
