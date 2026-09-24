// scripts/check-i18n-keys.mjs —— 语言键守卫。
//
// 两类真事故它挡得住：
// 1. `t('nodes.acces.title')` 这种键名打错——运行时不会报错，只是页面上出现键名；
// 2. 模板里写了 `{{t:foo.bar}}` 但字典没有——启动期会抛错，但那要等到重启。
// 对照基准语言（en）逐个校验，任何缺失都以非零码退出（可挂 CI）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = join(root, 'src', 'i18n', 'locales')
const dict = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'))

const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'dist-release' || entry === 'data') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    // 测试文件排除：它们会故意用不存在的键（断言回退行为）。
    else if (/\.(js|mjs|ts|html)$/.test(entry) && !/\.test\.(js|mjs|ts)$/.test(entry)) out.push(full)
  }
  return out
}

// 文档/注释里出现的示例键名（`{{t:key}}`、`{{t:...}}`）不是真实引用。
const IGNORED = new Set(['key', '...'])

// 模板里拼出来的键静态看不见（如 t(`runs.state.${state}`)、t(`lang.${tag}`)），
// 列为动态前缀：它们出现在“未引用”清单里只会误导人。
const DYNAMIC_PREFIXES = ['runs.state.', 'runs.trigger.', 'lang.', 'audit.kind.', 'chat.goal.']

const files = [...walk(join(root, 'public')), ...walk(join(root, 'src'))]
const used = new Map() // key -> 出现位置
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\bt\(\s*'([A-Za-z0-9_.-]+)'/g)) {
    if (IGNORED.has(match[1])) continue
    if (!used.has(match[1])) used.set(match[1], file)
  }
  for (const match of text.matchAll(/\{\{t:([A-Za-z0-9_.-]+)\}\}/g)) {
    if (IGNORED.has(match[1])) continue
    if (!used.has(match[1])) used.set(match[1], file)
  }
}

const missing = [...used.entries()].filter(([key]) => !(key in dict))
const zh = JSON.parse(readFileSync(join(localesDir, 'zh-CN.json'), 'utf8'))
const missingZh = [...used.keys()].filter((key) => !(key in zh))
const unused = Object.keys(dict).filter(
  (key) => !used.has(key) && !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)),
)

console.log(`i18n keys: 使用 ${used.size} 个 · 字典 ${Object.keys(dict).length} 个`)
if (missing.length > 0) {
  console.log('缺失（en）：')
  for (const [key, file] of missing) console.log(`  ${key}  ← ${file.replace(root + '\\', '')}`)
}
if (missingZh.length > 0) console.log(`缺失（zh-CN）：${missingZh.join(', ')}`)
if (unused.length > 0) console.log(`未被引用（可能是删代码后的残留）：${unused.join(', ')}`)

process.exit(missing.length === 0 && missingZh.length === 0 ? 0 : 1)
