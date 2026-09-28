// @ts-check
// Capability one (2026-09-20): pure function layer of the add-node wizard -- runner selection and payload
// assembly, plus the yellow warning text for the host-process form. DOM assembly stays in nodes.js.
import { esc, t } from './ui.js'

/**
 * Assemble the POST /api/nodes payload. runner=auto omits the field (the backend decides container vs
 * process from the deployment); only an explicit choice is sent. An empty dsh_version means "follow the
 * first row of the matrix".
 * Capability four (M1-7): a chosen host means an agent-run remote node (host and url travel together).
 * @param {{ name: string, port: string, runner: string, dshVersion: string, host: string, url: string, agent: Record<string, unknown> }} input
 * @returns {Record<string, unknown>}
 */
export const nodeCreatePayload = (input) => {
  const port = Number(input.port)
  return {
    name: input.name,
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    ...(input.runner === 'auto' ? {} : { runner: input.runner }),
    ...(typeof input.dshVersion === 'string' && input.dshVersion !== '' ? { dsh_version: input.dshVersion } : {}),
    ...(typeof input.host === 'string' && input.host !== '' ? { host: input.host } : {}),
    ...(typeof input.url === 'string' && input.url !== '' ? { url: input.url } : {}),
    agent: input.agent,
  }
}

/**
 * Confirmation text for the host-process form -- that node runs with the local user's privileges and can
 * operate the whole machine (the same yellow-risk wording agreed in M5 §6).
 * @param {string} name
 * @returns {string}
 */
export const hostRunnerConfirmText = (name) =>
  t('nodes.form.hostRunnerConfirm', { name })

/**
 * Fleet M3-1: confirmation text for the third sandbox tier of an ops node (danger-full-access) -- full
 * machine capability, backstopped by approval cards (as agreed in Q2).
 * @param {string} name
 * @returns {string}
 */
export const dangerSandboxConfirmText = (name) =>
  t('nodes.form.dangerSandboxConfirm', { name })

/**
 * Capability two / P1: the option list for the "DSH version" dropdown on a node row (pure function).
 * Source = supportedDsh from GET /api/nodes (the matrix; the frontend never hardcodes the version list).
 * @param {Array<{ dsh: string, status: string }>} list
 * @param {string | null | undefined} current currently pinned version in config (null/empty = follow the default)
 * @returns {string}
 */
export const versionOptionsHtml = (list, current) => {
  const cur = typeof current === 'string' && current !== '' ? current : ''
  const opts = (Array.isArray(list) ? list : [])
    .map((v) => `<option value="${esc(v.dsh)}"${v.dsh === cur ? ' selected' : ''}>${esc(v.status === 'pending' ? t('nodes.version.pending', { version: v.dsh }) : v.dsh)}</option>`)
    .join('')
  return `<option value=""${cur === '' ? ' selected' : ''}>${esc(t('nodes.form.versionFollowDefault'))}</option>${opts}`
}
