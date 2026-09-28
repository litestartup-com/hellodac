import { readFileSync } from 'node:fs'

/**
 * Contrast guard for the view switcher's active state (WCAG 2.x).
 *
 * Incident background (2026-09-25 user report): hovering the selected item turned "background and text
 * both white". Root cause: .view-switch .on came after .btn-quiet:hover with a hard-coded color, so it
 * beat the hover rule, which only swaps the background -> white text on light grey, measured 1.14:1, text gone.
 *
 * Rather than restating the resulting numbers, this **parses and computes them live from style.css**:
 * colour values come from variables, backgrounds from the real cascade (.on -> .btn-quiet -> the button
 * base class), so a stylesheet change moves the guard with it instead of going stale-but-green.
 *
 * The parser is deliberately a "real rule table" rather than a regex glued to selectors: base rules are
 * comma lists (`button,\n.btn {`), and a one-dimensional regex misses exactly that shape.
 */
const css = readFileSync('public/assets/style.css', 'utf8')

/** Strip comments so the regex does not treat braces inside a comment as a rule. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Parse a stylesheet into a Map<selector, Map<property, value>>.
 * Only flat top-level rules count; rules inside @media would throw off brace counting, so depth skips them.
 */
const parseRules = (cssText) => {
  const text = stripComments(cssText)
  const rules = new Map()
  let depth = 0
  let selStart = 0
  let bodyStart = -1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) {
        bodyStart = i
        // Record the selector list (whether this is @media is not known yet)
        const selText = text.slice(selStart, i).trim()
        void selText
      }
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const selectorList = text.slice(selStart, bodyStart).trim()
        const body = text.slice(bodyStart + 1, i)
        // @media / @supports do not enter the rule table (their inner rules were already skipped at depth>0)
        if (!selectorList.startsWith('@')) {
          const decls = new Map()
          for (const part of body.split(';')) {
            const idx = part.indexOf(':')
            if (idx <= 0) continue
            decls.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim())
          }
          for (const one of selectorList.split(',')) {
            const key = one.trim().replace(/\s+/g, ' ')
            if (key !== '' && !rules.has(key)) rules.set(key, decls)
          }
        }
        selStart = i + 1
      }
    }
  }
  return rules
}

const RULES = parseRules(css)
const varOf = (name) => {
  const root = RULES.get(':root')
  const raw = root?.get(`--${name}`)
  if (raw === undefined) throw new Error(`CSS variable --${name} not found`)
  return raw
}

/** Resolve var(...) inside a single declaration (one level is enough). */
const resolve = (value) => {
  if (value === undefined) return undefined
  const m = /^var\(\s*--([\w-]+)\s*\)$/.exec(value.trim())
  return m === null ? value.trim() : varOf(m[1])
}

/** Walk the cascade in order and take the first value that "is a colour" (none/transparent do not count). */
const through = (selectors, prop) => {
  for (const sel of selectors) {
    for (const p of [prop, `${prop}-color`]) {
      const v = resolve(RULES.get(sel)?.get(p))
      if (v !== undefined && v !== 'none' && v !== 'transparent') return v
    }
  }
  throw new Error(`no ${prop} in the cascade: ${selectors.join(' -> ')}`)
}

const lum = (hex) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (fg, bg) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

const AA = 4.5

// Foreground: the color .on writes itself (it only falls through to .btn-quiet when unset)
const onColor = resolve(RULES.get('.view-switch .on')?.get('color')) ?? resolve(RULES.get('.btn-quiet')?.get('color'))
// Normal-state background: .on writes none -> .btn-quiet is none -> the button base class's --surface
const bgNormal = through(['.view-switch .on', '.btn-quiet', 'button'], 'background')
// Hover background: .btn-quiet:hover wins in the cascade (this is the incident spot)
const bgHover = through(['.btn-quiet:hover'], 'background')

const normal = ratio(onColor, bgNormal)
const hover = ratio(onColor, bgHover)

console.log('View switcher active-state contrast (WCAG AA = 4.5:1)\n')
console.log(`  parsed: foreground ${onColor} / normal bg ${bgNormal} / hover bg ${bgHover}\n`)

const report = (label, fg, bg, r) => {
  console.log(`${r >= AA ? '✓' : '✗'} ${label.padEnd(16)} ${fg} on ${bg}  ${r.toFixed(2)}:1`)
  return r >= AA
}
const okNormal = report('normal', onColor, bgNormal, normal)
const okHover = report('hover', onColor, bgHover, hover)

console.log('\nIf either of these two numbers drops below 4.5, the active state is clashing text and')
console.log('background again -- exactly the bug the user reported on 2026-09-25.')

if (!okNormal || !okHover) {
  console.log('\n✗ contrast below the threshold')
  process.exit(1)
}
console.log('\n✓ both normal and hover pass')
