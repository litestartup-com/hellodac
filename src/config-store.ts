/**
 * Debt A3: atomic writes to the truth source (`manager.config.yaml` / any config file).
 *
 * The old code was read -> parse (a JS object) -> stringify -> write straight to the same path, with four problems:
 * 1. Truncation on a crash: the process dies halfway through the write = a broken config, and the manager refuses to start next time (loadConfig fails loud);
 * 2. Lost comments: `manager.config.yaml` is the only hand-edited entry point (AGENTS A-1), and its comments and hand-made formatting are the documentation itself;
 * 3. No post-write validation: a bad structure is only discovered once written, and it has already overwritten the previous version;
 * 4. Concurrent writes overwrite each other (two provision requests, one adding and one deleting).
 *
 * This module: the Document API keeps comments -> `.tmp` + `rename` is atomic -> a post-write read-back validates,
 * and a failure restores the previous version and throws -- a bad config never stays in the truth source.
 */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { parseDocument, stringify, type Document } from 'yaml'
import { loadConfig } from './config.js'

let chain: Promise<unknown> = Promise.resolve()

/** The in-process write lock: concurrent read-modify-write calls run serially and never overwrite each other. */
export const withConfigLock = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const run = chain.then(fn)
  chain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * Atomic write: write `<path>.tmp` first, then rename. A failure along the way clears the .tmp, never leaving
 * a half-written file that would be taken for the newest config. `mode` is optional (0600 for .env, say).
 * `io.rename` is injectable (tests simulate mount-point cases such as EBUSY).
 */
export interface AtomicIo {
  rename?: (from: string, to: string) => void
}

export const writeFileAtomic = (path: string, content: string, mode?: number, io: AtomicIo = {}): void => {
  const doRename = io.rename ?? renameSync
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode)
      } catch {
        // The permission model does not support it (Windows) -- not a failure
      }
    }
    try {
      doRename(tmp, path)
    } catch (renameError) {
      // The truth file in the container shape used to be a **file-level bind mount** (compose: ./.env:/app/.env),
      // and on Linux a mount point cannot be replaced by a rename (EBUSY) -- proven by compose-e2e:
      // POST /api/nodes 500 "EBUSY rename /app/.env.tmp -> /app/.env".
      // It falls back to an in-place write: atomicity gives way to "it works" here (the same trade-off
      // routes/auth.ts makes for clearInitialPassword, which has long handled it this way). Write
      // permission on the file itself (a chown to HOST_UID) is still the hard gate, and when that fails too the fallback error is thrown.
      try {
        writeFileSync(path, content, 'utf8')
        if (mode !== undefined) {
          try {
            chmodSync(path, mode)
          } catch {
            // The permission model does not support it (Windows) -- not a failure
          }
        }
        rmSync(tmp, { force: true })
        return
      } catch (fallbackError) {
        throw new Error(
          `atomic write failed (rename: ${renameError instanceof Error ? renameError.message : String(renameError)}) ` +
            `and the in-place fallback failed too (${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`
        )
      }
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // A .tmp that cannot be cleared does not affect correctness
    }
    throw error
  }
}

export type YamlValidate = 'none' | 'syntax' | 'full'

/**
 * Read -> Document (comments kept) -> mutate -> stringify -> atomic write -> read-back validation.
 *
 * Validation semantics:
 * - `syntax`: the parseDocument read-back after the write must parse (against disk-level corruption);
 * - `full`: `loadConfig` must load after the write (provision writes the complete truth source),
 *   and a failure = restore the previous version and throw;
 * - `none`: skip validation (generating a brand-new file, which has no complete semantics yet).
 */
export const mutateYamlFile = (
  path: string,
  mutate: (doc: Document) => void,
  opts: { validate?: YamlValidate } = {},
): void => {
  const validate = opts.validate ?? 'syntax'
  const before = readFileSync(path, 'utf8')
  const doc = parseDocument(before)
  // Debt R6: parseDocument does not throw on syntax errors, it only attaches errors to the returned document. Not checking them =
  // leaving "refuse the rewrite" to the stringify further downstream as a backstop (with a worse message), and worse,
  // the post-write read-back validation (below) does nothing at all about syntax errors. Here it is refused explicitly, with a readable error.
  if (doc.errors.length > 0) {
    throw new Error(
      `refusing to rewrite ${path}: existing YAML has syntax errors (${doc.errors.map((e) => e.message).join('; ')})`,
    )
  }
  mutate(doc)
  const next = stringify(doc, { lineWidth: 0 })
  if (next === before) return
  writeFileAtomic(path, next)
  try {
    if (validate === 'full') loadConfig(path)
    else if (validate === 'syntax') {
      // Debt R6: the read-back after the write has to check errors too -- the old code called parseDocument without checking,
      // so the "syntax validation" did nothing about syntax errors.
      const reread = parseDocument(readFileSync(path, 'utf8'))
      if (reread.errors.length > 0) {
        throw new Error(`syntax validation failed: ${reread.errors.map((e) => e.message).join('; ')}`)
      }
    }
  } catch (error) {
    // A bad config never stays in the truth source: restore the previous version and throw the error loudly
    try {
      writeFileAtomic(path, before)
    } catch (restoreError) {
      throw new Error(
        `config write rejected and restore failed: ${(error as Error).message}; restore: ${(restoreError as Error).message}`,
      )
    }
    throw new Error(`config write rejected (validation failed, previous version restored): ${(error as Error).message}`)
  }
}
