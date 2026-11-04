// @ts-check
// One cron row -- pure function layer, DOM assembly lives in crons.js. Same split as audit-row.js.
import { esc, t, when } from './ui.js'

/**
 * @param {{ id: string, name: string, agentName: string, schedule: string, enabled: boolean,
 *           nextRunAt: number | null, lastRunAt: number | null, lastState: string | null }} c
 * @returns {string}
 */
export const cronRow = (c) => {
  const run = c.lastRunAt !== null && c.lastRunAt !== undefined
    ? `${t('crons.lastRun')} ${esc(when(c.lastRunAt))}`
    : t('crons.neverRun')
  const next = c.nextRunAt !== null && c.nextRunAt !== undefined
    ? `${t('crons.nextRun')} ${esc(when(c.nextRunAt))}`
    : ''
  return `<div class="row" data-cron="${esc(c.id)}">
    <div class="row-main">
      <div class="row-title">
        <label class="toggle">
          <input type="checkbox" data-toggle data-id="${esc(c.id)}" ${c.enabled ? 'checked' : ''} />
          <span>${esc(c.name)}</span>
        </label>
      </div>
      <div class="row-sub">${esc(c.agentName)} · ${esc(c.schedule)} · ${run}${next !== '' ? ` · ${next}` : ''}</div>
    </div>
    <div class="row-actions">
      <button type="button" class="btn small" data-edit data-id="${esc(c.id)}">${esc(t('crons.editPrompt'))}</button>
    </div>
  </div>`
}
