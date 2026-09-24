// 登录页脚本。
//
// P1-1：从 login.html 的内联 <script> 搬出来 —— CSP 的 script-src 'self' 不放行
// 内联脚本，而登录页是唯一一张不在 shell 里的页面（没有会话就取不到侧栏数据）。
import { t, loadI18n } from './ui.js'

// 字典先就位再画：登录页也要按语言显示（DAC v1.0.0）。
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
      // 蜂群2计划 P3：首登强制改密
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
