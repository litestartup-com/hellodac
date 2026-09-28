// Hive P5.2: skill inventory (read-only in v1).
//
// Source of truth = the .skills/<name>/SKILL.md of each agent workspace; version = that workspace's git
// HEAD (same source as the run audit). Enabling/disabling and distributing belong to P5.5 config
// write-back, so this page does not pretend to offer them.
import { $, esc, setHtml, apiJson, poll, t, loadI18n } from './ui.js'

await loadI18n()

const versionChip = (v) =>
  v === null ? `<span class="pill-mini muted">${esc(t('skills.noVersion'))}</span>` : `<span class="pill-mini">@${esc(v.slice(0, 7))}</span>`

const agentGroup = (a) => {
  const rows =
    a.skills.length === 0
      ? `<p class="muted small">${esc(t('skills.agentEmpty'))}</p>`
      : a.skills
          .map(
            (s) => `<div class="node-row">
              <div class="node-main">
                <div class="node-title">${esc(s.name)}</div>
                ${s.description !== '' ? `<div class="node-detail">${esc(s.description)}</div>` : ''}
                <div class="node-meta"><code>${esc(s.file)}</code></div>
              </div>
            </div>`,
          )
          .join('')
  return `<div class="skills-agent">
    <div class="skills-agent-head">
      <strong>${esc(a.agentName)}</strong>
      <span class="muted small"><code>${esc(a.workspacePath)}</code></span>
      ${versionChip(a.version)}
    </div>
    <div class="nodes-list">${rows}</div>
  </div>`
}

const load = async () => {
  try {
    const r = await apiJson('/api/skills')
    if (!r.ok) return
    const data = r.data

    setHtml(
      'repo-note',
      data.repo === null
        ? `<strong>${esc(t('skills.repoMissing'))}</strong> <code>${esc('~/.dac/skills')}</code> ${esc(t('skills.repoMissingNote'))}`
        : `<strong>${esc(t('skills.repoLabel'))}</strong> <code>${esc(data.repo.path)}</code> ${versionChip(data.repo.version)} · ${esc(t('skills.repoNote'))}`,
    )

    setHtml('skills-list', data.agents.map(agentGroup).join(''))
    $('skills-refresh').textContent = t('skills.refreshAt', { time: new Date().toLocaleTimeString(undefined, { hour12: false }) })
  } catch {
    // keep the previous frame
  }
}

void load()
// Debt F4: page-level polling goes through ui.js poll (suspends while the document is hidden, backs off on error)
poll(() => void load(), 30_000)
