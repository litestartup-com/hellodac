/**
 * 债务 A3:真相源(`manager.config.yaml` / 任意配置文件)的原子写。
 *
 * 旧代码 read → parse(JS 对象)→ stringify → 直写同一路径,四个问题:
 * 1. 崩溃截断:写一半进程死 = 配置损坏,manager 下次启动直接拒启(loadConfig fail-loud);
 * 2. 丢注释:`manager.config.yaml` 是唯一手改入口(AGENTS A-1),注释与手工格式是文档本体;
 * 3. 无写后校验:坏结构写进去才发现,而且已经覆盖了上一版;
 * 4. 并发写互相覆盖(provision 新增/删除两个请求)。
 *
 * 本模块:Document API 保注释 → `.tmp` + `rename` 原子 → 写后回读校验,
 * 失败自动还原上一版并抛错——坏配置绝不留在真相源。
 */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { parseDocument, stringify, type Document } from 'yaml'
import { loadConfig } from './config.js'

let chain: Promise<unknown> = Promise.resolve()

/** 进程内写锁:并发的 read-modify-write 串行执行,绝不互相覆盖。 */
export const withConfigLock = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const run = chain.then(fn)
  chain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 原子写:先写 `<path>.tmp` 再 rename。中途失败清 .tmp,绝不留下会被当成
 * 最新配置的半成品。`mode` 可选(如 .env 的 0600)。
 * `io.rename` 可注入(测试模拟 EBUSY 等挂载点场景)。
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
        // 权限模型不支持(Windows)——不是失败
      }
    }
    try {
      doRename(tmp, path)
    } catch (renameError) {
      // 容器形态的真相文件曾是**文件级 bind mount**（compose: ./.env:/app/.env），
      // Linux 上挂载点不能被 rename 顶替（EBUSY）——compose-e2e 实证：
      // POST /api/nodes 500 "EBUSY rename /app/.env.tmp → /app/.env"。
      // 回落为原地写：原子性在此让位于"能用"（与 routes/auth.ts
      // clearInitialPassword 同款取舍，那里早已这么处理）。文件本身的写
      // 权限（chown 到 HOST_UID）仍是硬门槛，兜不住时抛回落错误。
      try {
        writeFileSync(path, content, 'utf8')
        if (mode !== undefined) {
          try {
            chmodSync(path, mode)
          } catch {
            // 权限模型不支持(Windows)——不是失败
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
      // 清不掉的 .tmp 不影响正确性
    }
    throw error
  }
}

export type YamlValidate = 'none' | 'syntax' | 'full'

/**
 * 读 → Document(保注释)→ mutate → stringify → 原子写 → 回读校验。
 *
 * 校验语义:
 * - `syntax`:写后回读 parseDocument 必须可解析(防磁盘级损坏);
 * - `full`:写后 `loadConfig` 必须可加载(provision 写的是完整真相源),
 *   失败 = 还原上一版并抛错;
 * - `none`:跳过校验(全新文件生成,尚无完整语义)。
 */
export const mutateYamlFile = (
  path: string,
  mutate: (doc: Document) => void,
  opts: { validate?: YamlValidate } = {},
): void => {
  const validate = opts.validate ?? 'syntax'
  const before = readFileSync(path, 'utf8')
  const doc = parseDocument(before)
  // 债务 R6:parseDocument 对语法错误不抛,只在返回文档上挂 errors。不查 =
  // 把「拒绝改写」交给更下游的 stringify 兜底(报错信息差),更糟的是写后
  // 回读校验(见下)对语法错误完全空转。这里显性拒绝,错误可读。
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
      // 债务 R6:写后回读同样必须检查 errors——旧代码只 parseDocument 不查,
      // 「syntax 校验」对语法错误是空转。
      const reread = parseDocument(readFileSync(path, 'utf8'))
      if (reread.errors.length > 0) {
        throw new Error(`syntax validation failed: ${reread.errors.map((e) => e.message).join('; ')}`)
      }
    }
  } catch (error) {
    // 坏配置绝不留在真相源:还原上一版,错误显性抛出
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
