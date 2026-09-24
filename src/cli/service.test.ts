import { test } from 'node:test'
import assert from 'node:assert/strict'
import { systemdUnit, windowsLauncher } from './service.js'

test('蜂群 P6: windows launcher pins the repo root and the sandbox env', () => {
  const content = windowsLauncher('C:/apps/dac')
  assert.match(content, /cd \/d "C:\/apps\/dac"/)
  assert.match(content, /set DSH_PERMISSION_MODE=read-only/)
  assert.match(content, /npm start/)
  assert.ok(content.includes('\r\n'), 'cmd 批处理必须 CRLF')
})

test('蜂群 P6: systemd unit pins cwd, node bin and restart policy', () => {
  const unit = systemdUnit('/home/me/dac', '/usr/bin/node')
  assert.match(unit, /WorkingDirectory=\/home\/me\/dac/)
  assert.match(unit, /ExecStart=\/usr\/bin\/node dist\/index\.js/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /WantedBy=default\.target/)
  assert.ok(!unit.includes('\r'), 'unit 文件必须 LF')
})
