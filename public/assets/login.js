// Login page script.
//
// P1-1: moved out of the inline <script> in login.html -- CSP script-src 'self' does not allow inline
// scripts, and the login page is the only page outside the shell (no session means no sidebar data).
import { t, loadI18n } from './ui.js'

// Dictionary first, then draw: the login page follows the language too (DAC v1.0.0).
await loadI18n()

const form = document.getElementById('form')
const errorEl = document.getElementById('error')
const submit = document.getElementById('submit')

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  errorEl.hidden = true
  submit.disabled = true
  submit.textContent = t('login.submitting')
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    })
    if (response.ok) {
      // Hive plan P3: force a password change on first login
      const body = await response.json().catch(() => ({}))
      window.location.href = body.mustChangePassword === true ? '/password' : '/'
      return
    }
    errorEl.textContent = response.status === 429 ? t('login.rateLimited') : t('login.badCredentials')
    errorEl.hidden = false
  } catch {
    errorEl.textContent = t('login.unreachable')
    errorEl.hidden = false
  } finally {
    submit.disabled = false
    submit.textContent = t('login.submit')
  }
})
