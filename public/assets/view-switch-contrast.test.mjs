import { readFileSync } from 'node:fs'

/**
 * 视图切换器选中态对比度守卫（WCAG 2.x）。
 *
 * 事故背景（2026-09-25 用户上报）：选中项悬停时「背景和字都变白」。
 * 根因是 .view-switch .on 排在 .btn-quiet:hover 之后、又写死了 color，于是盖掉
 * hover 规则；而 hover 规则只换背景不管前景 → 白字压浅灰，实测 1.14:1，字没了。
 *
 * 这里不复述结果数字，而是**现场从 style.css 解析并计算**：色值读变量，背景读
 * 真实级联（.on → .btn-quiet → button 基类）。样式一改守卫跟着变，不会像写死
 * 数字那样过期还报绿。
 *
 * 解析刻意做成「真规则表」而不是正则拼选择器：基础规则是逗号列表
 * （`button,\n.btn {`），一维正则碰这种形状就漏。
 */
const css = readFileSync('public/assets/style.css', 'utf8')

/** 去掉注释，避免正则把注释里的花括号当规则。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 把样式表解析成 Map<选择器, Map<属性, 值>>。
 * 只认顶层平铺规则；@media 等块内的规则会让花括号计数错位，所以按嵌套深度跳过。
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
        // 记录选择器列表（此时还不知道是不是 @media）
        const selText = text.slice(selStart, i).trim()
        void selText
      }
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const selectorList = text.slice(selStart, bodyStart).trim()
        const body = text.slice(bodyStart + 1, i)
        // @media / @supports 这类不落规则表（它们的内部规则已在 depth>0 被跳过）
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
  if (raw === undefined) throw new Error(`找不到 CSS 变量 --${name}`)
  return raw
}

/** 解析单条声明里的 var(...)（只支持一层，够用）。 */
const resolve = (value) => {
  if (value === undefined) return undefined
  const m = /^var\(\s*--([\w-]+)\s*\)$/.exec(value.trim())
  return m === null ? value.trim() : varOf(m[1])
}

/** 沿级联顺序取第一个"是颜色"的值（none/transparent 不算）。 */
const through = (selectors, prop) => {
  for (const sel of selectors) {
    for (const p of [prop, `${prop}-color`]) {
      const v = resolve(RULES.get(sel)?.get(p))
      if (v !== undefined && v !== 'none' && v !== 'transparent') return v
    }
  }
  throw new Error(`级联里找不到 ${prop}：${selectors.join(' → ')}`)
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

// 前景：.on 自己写的 color（没写才落到 .btn-quiet）
const onColor = resolve(RULES.get('.view-switch .on')?.get('color')) ?? resolve(RULES.get('.btn-quiet')?.get('color'))
// 常态背景：.on 未写背景 → .btn-quiet 是 none → button 基类 --surface
const bgNormal = through(['.view-switch .on', '.btn-quiet', 'button'], 'background')
// 悬停背景：.btn-quiet:hover 在级联里赢（这才是事故点）
const bgHover = through(['.btn-quiet:hover'], 'background')

const normal = ratio(onColor, bgNormal)
const hover = ratio(onColor, bgHover)

console.log('视图切换器选中态对比度（WCAG AA = 4.5:1）\n')
console.log(`  解析：前景 ${onColor} / 常态底 ${bgNormal} / 悬停底 ${bgHover}\n`)

const report = (label, fg, bg, r) => {
  console.log(`${r >= AA ? '✓' : '✗'} ${label.padEnd(16)} ${fg} on ${bg}  ${r.toFixed(2)}:1`)
  return r >= AA
}
const okNormal = report('常态', onColor, bgNormal, normal)
const okHover = report('悬停', onColor, bgHover, hover)

console.log('\n这两个数任何一个跌破 4.5，就说明选中态又出现了「字和底撞色」——')
console.log('正是用户 2026-09-25 报的那个 bug。')

if (!okNormal || !okHover) {
  console.log('\n✗ 对比度不达标')
  process.exit(1)
}
console.log('\n✓ 常态与悬停均达标')
