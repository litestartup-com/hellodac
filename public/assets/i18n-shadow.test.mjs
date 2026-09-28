// i18n shadowing guard (the 2026-09-24 production incident): frontend modules import the translation
// function `t` from ui.js, but a module often also has a local `const t = tokens(usage)` -- which
// **shadows** the imported t(), so `t('chat.turn.copyAnswer')` in the same scope throws "t is not a function".
//
// Three sites in the incident: footer in chat-render.js, chatTitle in chat.js, renderTotals in spend.js
// (all user-visible paths: the buttons under an answer, the new-chat title, the spend-total note).
// A static guard covers this class better than rendering test by test -- the page script (chat.js) cannot render under Node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const modules = readdirSync(here).filter((f) => f.endsWith('.js') && !f.endsWith('.test.mjs'))

test('i18n guard: a frontend module must not shadow the translation function t() with a short name other than t / td', () => {
  const offenders = []
  for (const file of modules) {
    const text = readFileSync(join(here, file), 'utf8')
    // Only files that really use the translation function (they import t or call t('key')).
    const usesTranslate = /import[^']*'\.\/ui\.js'/.test(text) && /\bt\(/.test(text)
    if (!usesTranslate) continue
    for (const match of text.matchAll(/^\s*(?:const|let|var)\s+t\s*=/gm)) {
      const line = text.slice(0, match.index).split('\n').length
      offenders.push(`${file}:${line}`)
    }
  }
  assert.deepEqual(offenders, [], `these sites shadow the translation function with a local t (renaming the variable is enough): ${offenders.join(', ')}`)
})

test('i18n guard: a frontend module must not use t as a function parameter name (the same kind of shadowing, easiest to trip over in a callback)', () => {
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
  assert.deepEqual(offenders, [], `these arrow functions shadow the translation function with a parameter named t: ${offenders.join(', ')}`)
})
