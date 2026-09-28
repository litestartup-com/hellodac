// Hive plan P3: the password change page (the only way out of the forced first-login change).
import { $, apiJson, t, loadI18n } from './ui.js'

await loadI18n()

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const error = $('error')
  error.hidden = true
  const next = $('next').value
  if (next !== $('confirm').value) {
    error.textContent = t('password.mismatch')
    error.hidden = false
    return
  }
  const save = $('save')
  save.disabled = true
  save.textContent = t('password.saving')
  try {
    // Debt F6: one Result layer -- the error code mapping is unchanged, only the text source moves to r.error/r.detail.
    const r = await apiJson('/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: $('current').value, newPassword: next }),
    })
    if (r.ok) {
      window.location.href = '/'
      return
    }
    error.textContent =
      r.error === 'invalid_current_password'
        ? t('password.wrongCurrent')
        : r.error === 'password_too_short'
          ? t('password.tooShort')
          : r.detail
    error.hidden = false
  } catch (err) {
    error.textContent = t('password.unreachable', { message: err.message })
    error.hidden = false
  } finally {
    save.disabled = false
    save.textContent = t('password.submit')
  }
})
