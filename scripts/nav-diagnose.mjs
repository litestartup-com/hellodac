// Minimal DOM shim that imports the REAL ui.js + shell.js and simulates the
// home page (/app) environment, then clicks nav-collapse and reports what
// happened at every layer: listener attached? click delivered? class toggled?
//
//   node scripts/nav-diagnose.mjs

const listeners = new Map()
const elements = new Map()

const makeEl = (id) => ({
  id,
  tagName: 'DIV',
  classList: {
    _set: new Set(),
    add: (...cs) => cs.forEach((c) => elements.get(id)._set && null),
    contains: (c) => false,
  },
  dataset: {},
  textContent: '',
  innerHTML: '',
  value: '',
  hidden: false,
  addEventListener: (event, fn) => {
    const key = `${id}:${event}`
    if (!listeners.has(key)) listeners.set(key, [])
    listeners.get(key).push(fn)
  },
  setAttribute: () => {},
  focus: () => {},
  scrollIntoView: () => {},
  append: () => {},
  remove: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
})

// ids referenced by shell.js + the home page
const ids = [
  'who', 'agent-count', 'agent-nav', 'avatar', 'side-endpoints', 'nav-open', 'nav-collapse', 'nav-backdrop',
  'logout', 'topbar-title', 'cron-hint', 'spend-hint', 'archive-hint', 'agent-panel', 'agent-panel-title',
  'agent-panel-content', 'suggest', 'suggest-hide', 'suggest-grid', 'quick-board', 'run-identity', 'run-who',
  'run-path', 'run-prompt', 'run-agent', 'run-scope', 'run-state', 'run-submit', 'run-result', 'run-form',
  'banners', 'runs', 'new-task',
]
for (const id of ids) elements.set(id, makeEl(id))

// nav-collapse needs classList.contains('nav-rail') on BODY, not itself.
const body = {
  tagName: 'BODY',
  _rail: false,
  _open: false,
  appendChild: () => {},
  classList: {
    contains: (c) => (c === 'nav-rail' ? body._rail : c === 'nav-open' ? body._open : false),
    toggle: (c, on) => {
      if (c === 'nav-rail') body._rail = on
      else if (c === 'nav-open') body._open = on
    },
    add: (c) => {
      if (c === 'nav-rail') body._rail = true
      else if (c === 'nav-open') body._open = true
    },
    remove: (c) => {
      if (c === 'nav-rail') body._rail = false
      else if (c === 'nav-open') body._open = false
    },
  },
}

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
}

const document = {
  body,
  activeElement: null,
  getElementById: (id) => (elements.has(id) ? elements.get(id) : null),
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  addEventListener: () => {},
  dispatchEvent: () => {},
  visibilityState: 'visible',
}

const listenersOn = (id, event) => (listeners.get(`${id}:${event}`) ?? []).length

globalThis.document = document
globalThis.window = {
  location: { pathname: '/app', hash: '' },
  addEventListener: () => {},
  dispatchEvent: () => {},
  matchMedia: (q) => ({ matches: q.includes('min-width'), addEventListener: () => {}, removeEventListener: () => {} }),
  alert: () => {},
  confirm: () => true,
  prompt: () => null,
  localStorage: globalThis.localStorage,
}
globalThis.CustomEvent = class {
  constructor(type, init) {
    this.type = type
    this.detail = init?.detail
  }
}
globalThis.HTMLElement = class {}
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })

const click = (id) => {
  const fns = listeners.get(`${id}:click`) ?? []
  console.log(`click ${id}: ${fns.length} listener(s)`)
  for (const fn of fns) fn({ target: elements.get(id), preventDefault: () => {} })
}

try {
  const { loadShell } = await import('../public/assets/shell.js')
  console.log('shell.js imported ok')
  console.log('listener counts:', {
    'nav-collapse:click': listenersOn('nav-collapse', 'click'),
    'nav-open:click': listenersOn('nav-open', 'click'),
    'nav-backdrop:click': listenersOn('nav-backdrop', 'click'),
  })
  console.log('before click: nav-rail =', body._rail, ', nav-open =', body._open)
  click('nav-collapse')
  console.log('after click:  nav-rail =', body._rail, ', nav-open =', body._open)
  click('nav-collapse')
  console.log('after click 2: nav-rail =', body._rail, ', nav-open =', body._open)
  await loadShell()
} catch (error) {
  console.error('IMPORT FAILED:', error)
  process.exit(1)
}
