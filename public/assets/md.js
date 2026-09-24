// A small Markdown renderer for agent replies.
//
// Hand-written rather than `marked` + a sanitiser because the frontend has no
// build step (TECH.md §1) and a vendored pair of libraries would be ~50KB of
// unbuildable, unauditable text in `public/`. The subset below is what a coding
// agent actually emits: fences, inline code, headings, lists, tables, quotes,
// emphasis, links.
//
// SAFETY: every renderer here is escape-first. Text is escaped the moment it is
// read, and the only tags in the output are ones this file writes itself, so
// there is no path from model output to live markup. That ordering is the whole
// security argument -- a transform that ran before escaping, or one that
// interpolated a raw capture group, would reintroduce stored XSS on manager's
// own origin (see the note on `esc` in ui.js). Two consequences worth keeping:
//
//   - Every regex below runs against ALREADY-ESCAPED text, which is why link
//     matching looks for `&quot;` and friends rather than raw quotes.
//   - `href` is allow-listed by scheme. `javascript:` and `data:` are the
//     reason; a link the agent invented is not permitted to run anything.

import { esc, t, loadI18n } from './ui.js'

await loadI18n()

/** Schemes a link may use. Anything else renders as plain text, not a link. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|\/|\.\/|#)/i

const safeHref = (raw) => {
  const trimmed = raw.trim()
  if (trimmed === '' || !SAFE_HREF.test(trimmed)) return null
  return trimmed
}

/**
 * Inline formatting, applied to one already-escaped run of text.
 *
 * Code spans come out first and are parked as placeholders, so `**` or `_`
 * inside backticks stays literal -- otherwise `` `a_b_c` `` would sprout an
 * <em> in the middle of a filename.
 */
const inline = (escaped) => {
  const spans = []
  let out = escaped.replace(/(`+)([^`]+?)\1/g, (_m, _ticks, code) => {
    spans.push(code)
    return `\u0000${spans.length - 1}\u0000`
  })

  // Links before emphasis: a bracketed label may contain emphasis, but a URL
  // with underscores must not be italicised.
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    const safe = safeHref(href)
    if (safe === null) return whole
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })

  // Bare URLs. Trailing punctuation is left outside the link so a sentence like
  // "see https://x.example." does not linkify the full stop.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)([.,;:!?)]*)(?=\s|$)/g, (_m, before, url, tail) => {
    return `${before}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`
  })

  out = out
    .replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+?)~~/g, '<del>$1</del>')
    // Single-asterisk emphasis only; `_` is left alone because snake_case
    // identifiers are far more common in this transcript than underscore italics.
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')

  return out.replace(/\u0000(\d+)\u0000/g, (_m, index) => `<code>${spans[Number(index)]}</code>`)
}

/** A fenced code block, with the language kept for styling only. */
const codeBlock = (lang, lines) => {
  const cls = /^[\w+-]{1,20}$/.test(lang) ? ` class="lang-${esc(lang)}"` : ''
  // DSH's CodeBlock grammar (stable class md-code-block): a banner carrying the
  // language and a copy button above the code. `md-copy` is wired in chat.js;
  // the code text itself stays escape-first (see the safety note above).
  return `<div class="md-code-block"><div class="md-code-banner"><span class="md-code-lang">${esc(lang || 'text')}</span><button type="button" class="md-copy">${esc(t('chat.md.copy'))}</button></div><pre${cls}><code>${esc(lines.join('\n'))}</code></pre></div>`
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

const cells = (line) =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => inline(esc(c.trim())))

/**
 * Renders Markdown to HTML.
 *
 * `text` is raw model output. An unterminated fence is treated as running to the
 * end of the input rather than being abandoned: replies are rendered while they
 * stream, so a half-arrived code block is the normal case, not a malformed one.
 */
export const md = (text) => {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0

  /** Collects consecutive list items at one nesting level. */
  const list = (ordered) => {
    const items = []
    const marker = ordered ? /^(\s*)\d+[.)]\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/
    while (i < lines.length) {
      const match = marker.exec(lines[i])
      if (match === null) break
      i += 1
      const parts = [match[2]]
      // A following indented line continues the same item, so a wrapped bullet
      // does not become a new paragraph.
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !marker.test(lines[i])) {
        parts.push(lines[i].trim())
        i += 1
      }
      items.push(`<li>${inline(esc(parts.join(' ')))}</li>`)
    }
    return `<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const closing = fence[1][0]
      const body = []
      i += 1
      while (i < lines.length) {
        const end = new RegExp(`^\\s*${closing === '`' ? '`' : '~'}{3,}\\s*$`).test(lines[i])
        if (end) { i += 1; break }
        body.push(lines[i])
        i += 1
      }
      out.push(codeBlock(fence[2], body))
      continue
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(esc(heading[2].trim()))}</h${level}>`)
      i += 1
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push('<hr>')
      i += 1
      continue
    }

    // Table: a header row followed by a divider row. Without the divider it is
    // just a paragraph that happens to contain pipes.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const body = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(`<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join('')}</tr>`)
        i += 1
      }
      out.push(
        `<table class="md-table-wide"><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.join('')}</tbody></table>`,
      )
      continue
    }

    if (/^\s*>/.test(line)) {
      const quoted = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${md(quoted.join('\n'))}</blockquote>`)
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) { out.push(list(false)); continue }
    if (/^\s*\d+[.)]\s+/.test(line)) { out.push(list(true)); continue }

    // Paragraph: consecutive lines until a blank line or a construct that starts
    // a new block. A single newline inside one becomes <br>, matching how agents
    // write multi-line prose without meaning a new paragraph.
    const para = []
    while (i < lines.length && lines[i].trim() !== '') {
      const next = lines[i]
      const startsBlock =
        /^\s*(`{3,}|~{3,})/.test(next) ||
        /^\s*#{1,6}\s/.test(next) ||
        /^\s*>/.test(next) ||
        /^\s*[-*+]\s+/.test(next) ||
        /^\s*\d+[.)]\s+/.test(next)
      if (startsBlock && para.length > 0) break
      para.push(next.trim())
      i += 1
    }
    out.push(`<p>${inline(esc(para.join('\n'))).replace(/\n/g, '<br>')}</p>`)
  }

  return out.join('')
}
