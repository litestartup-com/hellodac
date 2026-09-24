import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  LIMITS,
  metaSchema,
  pageSchema,
  parseBlock,
  type BoardModel,
  type BoardProblem,
  type Page,
  type RenderableBlock,
} from './model.js'

/**
 * Reads a workspace's dashboard data.
 *
 * Layout: `board/meta.json` holds the title and the as-of date; every other
 * `board/*.json` is one page, describing itself.
 *
 * A page is a whole file rather than an entry in a central index, so an agent
 * adds a page by writing one file. An index would have to be edited in the same
 * turn, and the moment those two writes disagree the board loses a page with no
 * error anywhere. Self-describing files cannot drift out of sync.
 */

export const BOARD_DIR = 'board'
const META_FILE = 'meta.json'

export interface BoardSource {
  /** Absolute path of the `board/` directory. */
  dir: string
  /** False when the workspace has never been initialised. */
  present: boolean
}

export const boardSource = (workspacePath: string): BoardSource => {
  const dir = join(workspacePath, BOARD_DIR)
  return { dir, present: existsSync(dir) }
}

/** Page files in load order. `meta.json` is configuration, not a page. */
const pageFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== META_FILE)
    .map((e) => e.name)
    .sort()

const readJson = (path: string): { value: unknown; error: string | null } => {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), error: null }
  } catch (error) {
    // Almost always a half-written file or a trailing comma from a hand edit.
    return { value: null, error: (error as Error).message }
  }
}

export const readBoard = (workspacePath: string, fallbackTitle: string): BoardModel => {
  const { dir, present } = boardSource(workspacePath)
  const problems: BoardProblem[] = []

  if (!present) {
    return { title: fallbackTitle, asOf: null, pages: [], problems }
  }

  // ---- meta -------------------------------------------------------------
  let title = fallbackTitle
  let asOf: string | null = null
  const metaPath = join(dir, META_FILE)
  if (existsSync(metaPath)) {
    const { value, error } = readJson(metaPath)
    if (error !== null) {
      problems.push({ file: `${BOARD_DIR}/${META_FILE}`, detail: `not valid JSON: ${error}` })
    } else {
      const parsed = metaSchema.safeParse(value)
      if (parsed.success) {
        title = parsed.data.title ?? fallbackTitle
        asOf = parsed.data.asOf ?? null
      } else {
        problems.push({ file: `${BOARD_DIR}/${META_FILE}`, detail: parsed.error.issues[0]?.message ?? 'invalid' })
      }
    }
  }

  // ---- pages ------------------------------------------------------------
  const pages: Page[] = []
  let names: string[]
  try {
    names = pageFiles(dir)
  } catch (error) {
    problems.push({ file: BOARD_DIR, detail: `cannot list the directory: ${(error as Error).message}` })
    return { title, asOf, pages, problems }
  }

  for (const name of names) {
    if (pages.length >= LIMITS.MAX_PAGES) {
      problems.push({ file: `${BOARD_DIR}/${name}`, detail: `ignored: more than ${LIMITS.MAX_PAGES} pages` })
      continue
    }

    const rel = `${BOARD_DIR}/${name}`
    const { value, error } = readJson(join(dir, name))
    if (error !== null) {
      problems.push({ file: rel, detail: `not valid JSON: ${error}` })
      continue
    }

    const parsed = pageSchema.safeParse(value)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue === undefined ? '' : ` (${issue.path.join('.') || 'root'}: ${issue.message})`
      problems.push({ file: rel, detail: `not a valid page${where}` })
      continue
    }

    const blocks: RenderableBlock[] = []
    parsed.data.blocks.forEach((raw, index) => {
      const { block, problem } = parseBlock(raw)
      blocks.push(block)
      // Recorded as well as rendered: the placeholder tells whoever is looking
      // at the board, the problem list tells whoever is fixing the agent.
      if (problem !== null) problems.push({ file: rel, detail: `block ${index}: ${problem}` })
    })

    pages.push({
      key: parsed.data.key ?? basename(name, '.json'),
      label: parsed.data.label,
      order: parsed.data.order ?? Number.MAX_SAFE_INTEGER,
      blocks,
    })
  }

  // Explicit order first; ties fall back to filename so the result is stable.
  pages.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.key.localeCompare(b.key)))

  return { title, asOf, pages, problems }
}
