import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 蜂群 P6：manager 服务化——开机自启 + 用户级服务。
 *
 * 零额外二进制：Windows 用任务计划（schtasks，登录时拉起），Linux 用
 * systemd user unit。全部用户级，不需要管理员。
 *
 *   npm run service -- install | uninstall | status
 */

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..') // 仓库根

/** Windows 启动包装：切到仓库根、带环境变量、npm start。 */
export const windowsLauncher = (rootDir: string): string => [
  '@echo off',
  `cd /d "${rootDir}"`,
  'set DSH_PERMISSION_MODE=read-only',
  'npm start',
  '',
].join('\r\n')

/** Linux systemd user unit。 */
export const systemdUnit = (rootDir: string, node: string): string => [
  '[Unit]',
  'Description=DAC (dsh agents manager)',
  'After=network-online.target',
  '',
  '[Service]',
  `WorkingDirectory=${rootDir}`,
  `ExecStart=${node} dist/index.js`,
  'Environment=DSH_PERMISSION_MODE=read-only',
  'Restart=on-failure',
  'RestartSec=5',
  '',
  '[Install]',
  'WantedBy=default.target',
  '',
].join('\n')

export const installWindows = (rootDir: string): { ok: boolean; detail: string } => {
  const script = join(rootDir, 'scripts', 'dac-start.cmd')
  mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, windowsLauncher(rootDir), 'utf8')
  try {
    execFileSync('schtasks', [
      '/create', '/f',
      '/tn', 'DacManager',
      '/tr', `"${script}"`,
      '/sc', 'onlogon',
      '/rl', 'limited',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, detail: `scheduled task DacManager created (starts ${script} at sign-in).` }
  } catch (error) {
    return { ok: false, detail: `schtasks failed: ${(error as Error).message.split('\n')[0]}` }
  }
}

export const uninstallWindows = (): { ok: boolean; detail: string } => {
  try {
    execFileSync('schtasks', ['/delete', '/f', '/tn', 'DacManager'], { stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, detail: 'scheduled task DacManager deleted.' }
  } catch (error) {
    return { ok: false, detail: `schtasks failed: ${(error as Error).message.split('\n')[0]}` }
  }
}

export const statusWindows = (): string => {
  try {
    return execFileSync('schtasks', ['/query', '/tn', 'DacManager'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split(/\r?\n/)
      .find((l) => l.includes('DacManager')) ?? 'scheduled task DacManager not found.'
  } catch {
    return 'scheduled task DacManager not found.'
  }
}

export const installLinux = (rootDir: string, node: string): { ok: boolean; detail: string } => {
  const unitDir = join(process.env.HOME ?? '.', '.config', 'systemd', 'user')
  const unit = join(unitDir, 'dac.service')
  try {
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(unit, systemdUnit(rootDir, node), 'utf8')
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
    execFileSync('systemctl', ['--user', 'enable', '--now', 'dac.service'], { stdio: 'ignore' })
    return { ok: true, detail: `systemd user unit enabled: ${unit} (systemctl --user status dac).` }
  } catch (error) {
    return { ok: false, detail: `systemctl failed: ${(error as Error).message.split('\n')[0]}` }
  }
}

export const uninstallLinux = (): { ok: boolean; detail: string } => {
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'dac.service'], { stdio: 'ignore' })
    return { ok: true, detail: 'systemd user unit disabled.' }
  } catch (error) {
    return { ok: false, detail: `systemctl failed: ${(error as Error).message.split('\n')[0]}` }
  }
}

export const statusLinux = (): string => {
  try {
    return execFileSync('systemctl', ['--user', 'is-active', 'dac.service'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return 'inactive (not installed or not running)'
  }
}

const main = (): void => {
  const [command] = process.argv.slice(2)
  const root = resolve(here)
  const node = process.execPath

  if (process.platform === 'win32') {
    if (command === 'uninstall') console.log(uninstallWindows().detail)
    else if (command === 'status') console.log(statusWindows())
    else console.log(installWindows(root).detail)
    return
  }
  if (command === 'uninstall') console.log(uninstallLinux().detail)
  else if (command === 'status') console.log(statusLinux())
  else console.log(installLinux(root, node).detail)
}

// 只在被直接执行时运行：被测试/其它模块 import 时绝不能有副作用
// （2026-09-05 实测踩坑——测试导入直接把真实计划任务装到了机器上）。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
