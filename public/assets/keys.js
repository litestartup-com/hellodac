// 对外 API 钥匙管理面（后台，会话 cookie 鉴权）。
//
// 明文只在创建响应里出现一次：创建成功后立刻显示在 token-reveal 区并提示"只显示这一次"，
// 列表永远拿不到它（服务端结构上就没有这个字段）。
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

await loadI18n()

const SCOPES = ['services:read', 'usage:read', 'tasks:write', 'conversations:write', 'interactions:write']

const stamp = (ms) => (ms === null || ms === undefined ? '—' : new Date(ms).toLocaleString())

const statePill = (key) => {
  if (key.revokedAt !== null) return `<span class="pill-mini muted">${esc(t('keys.revoked'))}</span>`
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return `<span class="pill-mini muted">${esc(t('keys.expired'))}</span>`
  return `<span class="pill-mini">${esc(t('keys.active'))}</span>`
}

const keyRow = (key) => `<div class="node-row">
  <div class="node-main">
    <div class="node-title">${esc(key.name)} ${statePill(key)}</div>
    <div class="node-detail"><code>${esc(key.id)}</code> · ${esc(key.scopeServices.join(', '))}</div>
    <div class="node-meta">${esc(key.scopes.join(', '))} · ${key.quotaRunsDay === null ? esc(t('keys.unlimited')) : `${key.quotaRunsDay}${esc(t('keys.perDay'))}`} · ${key.rateLimitRpm}${esc(t('keys.perMinute'))}</div>
    <div class="node-meta">${esc(t('keys.lastUsed'))}: ${esc(stamp(key.lastUsedAt))} · ${esc(t('keys.createdLabel'))}: ${esc(stamp(key.createdAt))}</div>
  </div>
  ${key.revokedAt === null ? `<div class="row-actions"><button class="btn" type="button" data-revoke="${esc(key.id)}">${esc(t('keys.revoke'))}</button></div>` : ''}
</div>`

const renderListener = (state) => {
  const el = $('keys-listener')
  if (el === null) return
  const where = `${state.host}:${state.port}`
  if (state.status === 'listening') {
    el.innerHTML = `${esc(t('keys.listenerUp'))} <code>http://${esc(where)}/v1</code>`
    return
  }
  const reason = state.detail === null ? '' : ` — ${esc(state.detail)}`
  el.innerHTML = `${esc(state.status === 'disabled' ? t('keys.listenerOff') : t('keys.listenerFailed'))}${reason}`
}

const load = async () => {
  const r = await apiJson('/api/keys')
  if (!r.ok) return
  const data = await r.json()
  renderListener(data.publicApi)

  const services = $('key-services')
  if (services !== null && services.options.length === 0) {
    services.innerHTML = data.services.map((s) => `<option value="${esc(s.id)}">${esc(s.label)} (${esc(s.id)})</option>`).join('')
  }
  const scopes = $('key-scopes')
  if (scopes !== null && scopes.options.length === 0) {
    scopes.innerHTML = SCOPES.map((s) => `<option value="${esc(s)}"${s === 'services:read' || s === 'usage:read' ? ' selected' : ''}>${esc(s)}</option>`).join('')
  }

  const list = $('keys-list')
  if (list === null) return
  setHtml(list, data.keys.length === 0 ? `<p class="muted small">${esc(t('keys.empty'))}</p>` : data.keys.map(keyRow).join(''))
  const refreshed = $('keys-refresh')
  if (refreshed !== null) refreshed.textContent = new Date().toLocaleTimeString()
}

const selected = (id) => Array.from($(id)?.selectedOptions ?? []).map((o) => o.value)

const create = async () => {
  const msg = $('key-create-msg')
  const name = $('key-name')?.value.trim() ?? ''
  if (name === '') {
    if (msg !== null) msg.textContent = t('keys.nameRequired')
    return
  }
  const services = selected('key-services')
  if (services.length === 0) {
    if (msg !== null) msg.textContent = t('keys.serviceRequired')
    return
  }
  const quotaRaw = Number($('key-quota')?.value ?? '200')
  const body = {
    name,
    services,
    scopes: selected('key-scopes'),
    quotaRunsDay: Number.isFinite(quotaRaw) && quotaRaw > 0 ? quotaRaw : null,
  }
  const response = await apiJson('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (msg !== null) msg.textContent = `${t('keys.createFailed')}: ${payload.detail ?? response.status}`
    return
  }
  if (msg !== null) msg.textContent = t('keys.created')
  const reveal = $('key-token')
  if (reveal !== null) {
    reveal.hidden = false
    setHtml(
      reveal,
      `<div class="node-title">${esc(t('keys.tokenOnce'))}</div>
       <code class="token-value">${esc(payload.token)}</code>
       <div class="node-meta">${esc(t('keys.id'))}: <code>${esc(payload.key.id)}</code></div>`,
    )
  }
  if ($('key-name') !== null) $('key-name').value = ''
  await load()
}

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target.id === 'key-create') void create()
  const id = target.dataset.revoke
  if (id !== undefined) {
    const msg = $('key-create-msg')
    void apiJson(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' }).then(async (response) => {
      if (msg !== null) msg.textContent = response.ok ? t('keys.revokedNow') : t('keys.revokeFailed')
      await load()
    })
  }
})

await load()
poll(load, 15_000)
