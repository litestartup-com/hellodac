// The archived conversations page.
//
// Archiving is a soft delete, and a soft delete nobody can see into is
// indistinguishable from a real one. This page is what makes 「归档」 an honest
// word: everything hidden from the sidebar is listed here, with the way back.

import { $, ago, banner, bannerHtml, esc, setHtml, when, apiJson, showError } from './ui.js'
import { t, loadI18n } from './ui.js'

// 字典先就位再渲染（服务端已渲染静态文案，动态文案靠它）。
await loadI18n()

const notice = (level, title, body) => {
  $('archive-notice').innerHTML = banner(level, title, body)
}

/** Same, for the one notice that carries a link. `body` must be pre-escaped. */
const noticeHtml = (level, title, body) => {
  $('archive-notice').innerHTML = bannerHtml({ level, title, body })
}

const row = (chat) => {
  const title = chat.title === null || chat.title === '' ? t('archive.newChat') : chat.title
  const turns = chat.turns > 0 ? t('archive.turns', { count: chat.turns }) : t('archive.noTurns')
  // The agent is named on every row: after a few weeks the useful question is
  // not "when" but "whose workspace was this writing to".
  const meta = [
    esc(chat.agentName),
    turns,
    esc(t('archive.lastActive', { time: ago(chat.lastActiveAt) })),
    esc(t('archive.archivedAt', { time: when(chat.removedAt) })),
  ]
  return `<div class="arch-row" data-id="${esc(chat.id)}">
      <div class="arch-main">
        <div class="arch-title">${esc(title)}</div>
        <div class="arch-meta">${meta.join(' · ')}</div>
      </div>
      ${
        chat.agentGone
          ? `<span class="pill warn" title="${esc(t('archive.agentRemoved'))}">${esc(t('archive.agentRemoved'))}</span>`
          : `<button class="btn-quiet btn-sm" type="button" data-restore="1">${esc(t('archive.restore'))}</button>`
      }
    </div>`
}

const load = async () => {
  try {
    // 债务 F6:统一 Result 层——notice 也走共享 showError(detail 自动转义)。
    const r = await apiJson('/api/chats/archived')
    if (!r.ok) {
      $('archive-notice').innerHTML = showError(r, t('archive.readFailed'))
      return
    }
    const { chats } = r.data
    $('archive-count').textContent = chats.length === 0 ? '' : t('archive.count', { count: chats.length })
    setHtml(
      'archive-list',
      chats.length === 0 ? `<p class="muted small">${esc(t('archive.empty'))}</p>` : chats.map(row).join(''),
    )
  } catch (error) {
    notice('bad', t('archive.readFailed'), error.message)
  }
}

// Delegated: the list is rewritten wholesale after every restore, so per-row
// listeners would be bound to nodes that no longer exist.
$('archive-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-restore]')
  if (button === null) return
  const id = button.closest('.arch-row').dataset.id
  button.disabled = true
  try {
    const r = await apiJson(`/api/chats/${encodeURIComponent(id)}/restore`, { method: 'POST' })
    if (!r.ok) {
      button.disabled = false
      $('archive-notice').innerHTML = showError(r, t('archive.restoreFailed'))
      return
    }
    // A link rather than a redirect: the session may come back `cold` or `lost`,
    // and opening it is the user's call, not a side effect of tidying up.
    noticeHtml('ok', t('archive.restored'), `<a href="/chat/${encodeURIComponent(id)}">${esc(t('archive.openChat'))}</a>`)
    await load()
  } catch (error) {
    button.disabled = false
    notice('bad', t('archive.restoreFailed'), error.message)
  }
})

void load()
