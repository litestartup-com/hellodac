import assert from 'node:assert/strict'
import test from 'node:test'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { md } = await import('./md.js')

/**
 * Tests for the Markdown renderer.
 *
 * The escaping cases are the point of this file. Everything else is convenience;
 * a hole in the escaping is stored XSS on the origin that holds the session
 * cookie, so those cases are written as assertions about what must NOT appear.
 */

test('escapes markup in prose, code and headings alike', () => {
  assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  assert.equal(md('# <script>alert(1)</script>'), '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>')
  assert.match(md('```\n<script>bad()</script>\n```'), /<pre><code>&lt;script&gt;bad\(\)&lt;\/script&gt;<\/code><\/pre>/)
  assert.equal(md('`<b>x</b>`'), '<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>')
})

test('code blocks carry the DSH banner: language label + copy button, code escaped', () => {
  const html = md('```js\nalert(1)\n```')
  assert.match(html, /<div class="md-code-block">/)
  assert.match(html, /<span class="md-code-lang">js<\/span>/)
  assert.match(html, /<button type="button" class="md-copy">Copy<\/button>/)
  assert.match(html, /<pre class="lang-js"><code>alert\(1\)<\/code><\/pre>/)
  // No language: the banner still names it "text" -- a bare fence is a text block.
  assert.match(md('```\nhi\n```'), /<span class="md-code-lang">text<\/span>/)
})

test('refuses link schemes that can execute', () => {
  // The label still renders; only the link is withheld, so the reader sees the
  // text the agent wrote and cannot be navigated by it.
  for (const href of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x']) {
    const html = md(`[click](${href})`)
    // The scheme survives as inert text -- that is the point, the reader sees
    // what the agent wrote -- so the assertion is about markup, not substrings.
    assert.doesNotMatch(html, /<a\b/, `${href} must not become a link`)
    assert.doesNotMatch(html, /href=/, `${href} must not reach an href`)
    assert.doesNotMatch(html, /<script|<img/i, `${href} must not emit tags`)
  }
})

test('renders safe links with noopener', () => {
  const html = md('[docs](https://example.com/a?b=1&c=2)')
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/)
  assert.match(md('[page](/board/personal)'), /<a href="\/board\/personal"/)
})

test('leaves emphasis inside code spans alone', () => {
  // A filename is the common case: `note_data_core` must not sprout an <em>.
  assert.equal(md('`a_b_c` and `x**y**z`'), '<p><code>a_b_c</code> and <code>x**y**z</code></p>')
})

test('does not italicise snake_case identifiers', () => {
  assert.equal(md('run_id and chat_id'), '<p>run_id and chat_id</p>')
})

test('renders emphasis, strong and strikethrough', () => {
  assert.equal(md('**bold** *it* ~~gone~~'), '<p><strong>bold</strong> <em>it</em> <del>gone</del></p>')
})

test('treats an unterminated fence as running to the end', () => {
  // The streaming case: a reply is rendered while it arrives, so a half-arrived
  // code block is normal and must not swallow or drop the text.
  const html = md('here:\n```js\nconst a = 1')
  assert.match(html, /<p>here:<\/p>/)
  assert.match(html, /<pre class="lang-js"><code>const a = 1<\/code><\/pre>/)
})
test('renders lists, including wrapped items', () => {
  assert.equal(md('- one\n- two'), '<ul><li>one</li><li>two</li></ul>')
  assert.equal(md('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>')
  assert.equal(md('- a line\n  continued'), '<ul><li>a line continued</li></ul>')
})

test('renders a table only when a divider row follows the header', () => {
  const html = md('| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.match(html, /<table class="md-table-wide"><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/)
  assert.match(html, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/)
  // Pipes without a divider are prose, not a one-row table.
  assert.equal(md('a | b'), '<p>a | b</p>')
})

test('renders blockquotes by recursion, so blocks nest', () => {
  assert.equal(md('> **hi**'), '<blockquote><p><strong>hi</strong></p></blockquote>')
  assert.match(md('> - a\n> - b'), /<blockquote><ul><li>a<\/li><li>b<\/li><\/ul><\/blockquote>/)
})

test('keeps a single newline inside a paragraph as a line break', () => {
  assert.equal(md('one\ntwo'), '<p>one<br>two</p>')
  assert.equal(md('one\n\ntwo'), '<p>one</p><p>two</p>')
})

test('starts a new block when a construct interrupts a paragraph', () => {
  assert.equal(md('intro\n- a'), '<p>intro</p><ul><li>a</li></ul>')
})

test('renders an empty input as nothing', () => {
  assert.equal(md(''), '')
  assert.equal(md(null), '')
  assert.equal(md(undefined), '')
})
