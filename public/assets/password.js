// 蜂群2计划 P3：修改密码页（首登强制改密的唯一出口）。
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
    // 债务 F6:统一 Result 层——错误码映射不变,文案来源换成 r.error/r.detail。
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
