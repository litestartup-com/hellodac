import assert from 'node:assert/strict'
import test from 'node:test'
import { brandInfo, csrfToken, money, moneyAdaptive, uniqueFrames, useBrand } from './ui.js'

test('a live snapshot and its buffered copy produce one user frame', () => {
  const user = { kind: 'user', text: 'hello', at: 1 }
  assert.deepEqual(uniqueFrames([user, { ...user }]), [user])
})

// Incident regression (2026-09-26 user report: "the Star on GitHub item is gone"):
// The server's BRAND fields are repoUrl/fullName/homepage, while client call sites use repo/full/site.
// brandInfo() has to normalize them -- without the mapping brand.repo stays empty,
// and shell.js skips the whole item on `brand.repo === ''` (the entry vanishes, not just the link).
test('incident regression: brandInfo maps the server field names onto the old client field names', () => {
  useBrand({
    name: 'DAC',
    fullName: 'Dispatched Agent Cluster',
    tagline: 'One Manager. A Fleet of Agents.',
    repoUrl: 'https://github.com/litestartup-com/hellodac',
    homepage: 'https://hellodac.com',
    supportEmail: 'support@hellodac.com',
  })
  const b = brandInfo()
  assert.equal(b.repo, 'https://github.com/litestartup-com/hellodac', 'repoUrl -> repo (otherwise Star on GitHub never renders)')
  assert.equal(b.full, 'Dispatched Agent Cluster', 'fullName → full')
  assert.equal(b.site, 'https://hellodac.com', 'homepage → site')
  assert.equal(b.supportEmail, 'support@hellodac.com')
})

test('brandInfo gives safe defaults before the brand is injected (empty repo -> no GitHub row in About)', () => {
  useBrand(null)
  const b = brandInfo()
  assert.equal(b.name, 'DAC')
  assert.equal(b.repo, '')
  assert.equal(b.supportEmail, '')
})

// Debt F8: backfilling the frontend tests -- money is the site-wide single implementation (Debt F2),
// so its precision behaviour is asserted directly here.
test('debt F2 regression: money defaults to 4 decimals, the digits argument is for compact cards', () => {
  assert.equal(money(12_340_000), '$12.3400')
  assert.equal(money(12_340_000, 2), '$12.34')
  assert.equal(money(null), '—')
})

test('debt F2 regression: moneyAdaptive scales precision by magnitude (a few cents never render as $0.00)', () => {
  assert.equal(moneyAdaptive(0), '$0')
  assert.equal(moneyAdaptive(5_000), '$0.0050')
  assert.equal(moneyAdaptive(500_000), '$0.500')
  assert.equal(moneyAdaptive(12_340_000), '$12.34')
  assert.equal(moneyAdaptive(null), '—')
})

// After the B2 rename the cookie name is uniformly `dac_csrf`: the transitional dual-read fallback went
// away with the production cutover (2026-09-24). What this guards is "exactly one name is accepted" --
// an unrelated name proves every other name is rejected. Note: the pre-rename name is deliberately
// **not** written here (the repo forbids the old brand string, and release:check's "old brand name is at
// zero" is a hard gate); matching a single name needs no old-name sample.
test('csrfToken accepts only dac_csrf; every other cookie name is rejected', () => {
  const withCookie = (cookie) => {
    globalThis.document = { cookie }
    return csrfToken()
  }
  assert.equal(withCookie('dac_csrf=new-token'), 'new-token', 'the new name must match')
  assert.equal(
    withCookie('mgr_sid=abc; dac_csrf=new-token; theme=dark'),
    'new-token',
    'must also be picked up from the middle of the cookie string',
  )
  assert.equal(withCookie('other_csrf=stale-token'), '', 'any other name is rejected (no dual-read fallback)')
  assert.equal(withCookie('mgr_sid=abc'), '', 'empty string when none is present (the server self-heals by reissuing on a 403)')
  delete globalThis.document
})
