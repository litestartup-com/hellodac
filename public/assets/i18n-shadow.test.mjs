// i18n 遮蔽守卫（2026-09-24 线上事故）：前端模块从 ui.js 导入翻译函数 `t`，
// 而模块里又常有 `const t = tokens(usage)` 这类局部变量——它**遮蔽**了导入的 t()，
// 于是同一作用域里的 `t('chat.turn.copyAnswer')` 抛 "t is not a function"。
//
// 事故现场三处：chat-render.js 的 footer、chat.js 的 chatTitle、spend.js 的
// renderTotals（都是用户可见路径：回答底部按钮、新会话标题、花费合计说明）。
// 静态守卫比逐个渲染测试更能覆盖这一类——页面脚本（chat.js）本身无法在 Node 里渲染。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const modules = readdirSync(here).filter((f) => f.endsWith('.js') && !f.endsWith('.test.mjs'))

test('i18n 守卫: 前端模块不得用 t / td 之外的短名遮蔽翻译函数 t()', () => {
  const offenders = []
  for (const file of modules) {
    const text = readFileSync(join(here, file), 'utf8')
    // 只关心真的在用翻译函数的文件（导入 t 或调用 t('key')）。
    const usesTranslate = /import[^']*'\.\/ui\.js'/.test(text) && /\bt\(/.test(text)
    if (!usesTranslate) continue
    for (const match of text.matchAll(/^\s*(?:const|let|var)\s+t\s*=/gm)) {
      const line = text.slice(0, match.index).split('\n').length
      offenders.push(`${file}:${line}`)
    }
  }
  assert.deepEqual(offenders, [], `这些位置用局部 t 遮蔽了翻译函数（改个变量名即可）：${offenders.join(', ')}`)
})

test('i18n 守卫: 前端模块不得把 t 用作函数参数名（同一类遮蔽，回调里最容易踩）', () => {
  const offenders = []
  for (const file of modules) {
    const text = readFileSync(join(here, file), 'utf8')
    const usesTranslate = /import[^']*'\.\/ui\.js'/.test(text) && /\bt\(/.test(text)
    if (!usesTranslate) continue
    for (const match of text.matchAll(/\(([^)]*)\)\s*=>/g)) {
      if (/(^|,)\s*t\s*(,|$)/.test(match[1])) {
        const line = text.slice(0, match.index).split('\n').length
        offenders.push(`${file}:${line}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `这些箭头函数的参数名 t 遮蔽了翻译函数：${offenders.join(', ')}`)
})
