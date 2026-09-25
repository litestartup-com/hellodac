import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 改密按钮样式契约（2026-09-26 用户反馈「password 按钮还是蓝色的」）。
 *
 * 断言的是**选择器与色值**，不是渲染结果——按钮颜色错了在测试里就该红，
 * 而不是等用户肉眼报。同时钉住两条纪律：
 *   1. 深墨覆盖必须挂 `#password-form`（只影响改密页）——挂 `.narrow` 会连带
 *      把登录页的蓝色 Sign in 一起改掉（登录页共用 .narrow）。
 *   2. 覆盖必须排在基础规则之后（CSS 里顺序即权重；写反了不生效）。
 */
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', '..', 'public', 'assets', 'style.css'), 'utf8')

/** 取某选择器块内某属性值（含 var() 原样返回）。 */
const declOf = (selector, prop) => {
  const block = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
  if (block === null) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'm').exec(block[1])
  return m === null ? null : m[1].trim()
}

test('密码页提交按钮是深墨，不是 accent 蓝', () => {
  const bg = declOf('#password-form button[type=\'submit\']', 'background')
  assert.ok(bg !== null, '必须有 #password-form 专属覆盖规则')
  assert.ok(/var\(--text\)/.test(bg), `底色应是 --text（实际 ${bg}）`)
  assert.ok(!/--accent/.test(bg), '不得再用 accent 蓝')
})

test('登录页的 .narrow 提交按钮仍保持 accent 蓝（共用选择器不得误伤）', () => {
  const bg = declOf('.narrow button[type=\'submit\']', 'background')
  assert.ok(/var\(--accent\)/.test(bg), `.narrow 基础规则仍是蓝（实际 ${bg}）`)
})

test('深墨覆盖必须写在基础规则之后（顺序即权重）', () => {
  const base = css.indexOf('.narrow button[type=\'submit\']')
  const override = css.indexOf('#password-form button[type=\'submit\']')
  assert.ok(base > 0 && override > base, `覆盖规则必须后于基础规则（base=${base}, override=${override}）`)
})
