import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 接线守卫：JS 里 $(...) / getElementById(...) 引用的 id，必须在页面模板或 layout
 * 里真的存在。
 *
 * 为什么值得一条测试：这类错（id 拼错、模板里忘了加元素）静态检查抓不到、纯函数
 * 单测也抓不到（那一层没有 DOM），只有在浏览器里点到那一步才炸。UI 精简这次一口气
 * 新增了十来个 id（连接命令 / 打开 / 复制 / 菜单浮层…），正是最容易漏的时刻。
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const readOrNull = (rel) => {
  try {
    return readFileSync(join(root, rel), 'utf8')
  } catch {
    return null
  }
}

const TEMPLATES = [
  'public/layout.html',
  'public/pages/nodes.html',
  'public/pages/runs.html',
  'public/pages/chat.html',
  'public/pages/skills.html',
  'public/pages/archive.html',
  'public/pages/spend.html',
  'public/pages/audit.html',
  'public/pages/password.html',
  'public/pages/login.html',
]

/**
 * 由 JS 自己拼出来的 id：不在模板里，显式登记。
 * 之所以写死而不是宽泛放行——新增动态 id 时必须有人想一下它归哪一类。
 */
const DYNAMIC = [
  /^node-menu-/, // node-row.js：每个节点一个主菜单浮层
  /^node-version-menu-/, // node-row.js：版本子菜单浮层
  /^node-more-/, // node-row.js：⋮ 触发器
  /^machines-revoked/, // nodes.js：已吊销机器折叠区
  /^dac-/, // 通用前缀
  /^nodes-link$/, // shell.js 侧栏导航项（来自 PRIMARY_NAV）
  /^nodes-hint$/,
  /^spend-hint$/,
  /^archive-hint$/,
  /^logout$/, // shell.js：溢出菜单里的登出按钮
]

const JS_FILES = ['nodes.js', 'shell.js', 'runs.js', 'menu.js', 'node-row.js', 'gui-access.js', 'run-row.js', 'machines.js', 'topology.js', 'node-form.js']

test('接线守卫: JS 引用的每个 DOM id 都能在模板里找到', () => {
  const html = TEMPLATES.map(readOrNull)
    .filter((t) => t !== null)
    .join('\n')
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  assert.ok(declared.size > 100, `模板 id 解析异常（只拿到 ${declared.size} 个）`)

  const isDynamic = (id) => DYNAMIC.some((re) => re.test(id))
  const missing = []
  for (const file of JS_FILES) {
    const text = readOrNull(`public/assets/${file}`)
    if (text === null) continue
    const ids = new Set()
    for (const m of text.matchAll(/\$\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)) ids.add(m[1])
    for (const m of text.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)) ids.add(m[1])
    for (const id of ids) {
      if (!declared.has(id) && !isDynamic(id)) missing.push(`${file}: #${id}`)
    }
  }
  assert.deepEqual(missing, [], `这些 id 在模板里不存在（点了才会炸）：\n  ${missing.join('\n  ')}`)
})
