import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 蜂群2计划 P6 回归：install.ps1 必须带 UTF-8 BOM。
 *
 * 实测现场：Windows PowerShell 5.1（官方推荐执行路径）对无 BOM 的 .ps1
 * 按 ANSI 代码页（中文系统 = GBK）解码——脚本里的中文串全部乱码，
 * 乱码字节又恰巧含引号/括号字节 → ParserError，脚本根本无法启动。
 * BOM 让 PS5.1 按 UTF-8 解码，问题消失。
 */
test('install.ps1 starts with a UTF-8 BOM so Windows PowerShell 5.1 can parse it', () => {
  const bytes = readFileSync(join(root, 'install.ps1'))
  assert.deepEqual(
    [bytes[0], bytes[1], bytes[2]],
    [0xef, 0xbb, 0xbf],
    'install.ps1 必须以 UTF-8 BOM 开头（否则 PS5.1 实测 ParserError）',
  )
  // BOM 之后必须是合法 UTF-8，杜绝半吊子编码
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes))
})

/**
 * 蜂群2计划 P6 回归：install.ps1 必须有 codeload zip 回退。
 *
 * 实测现场：中国网络 github.com git HTTPS 直接超时/重置（raw 也超时），
 * 只有 codeload.github.com 可达（实测 200）。没有回退 = Windows 裸机在
 * 国内装不上。回退路径装完可用；npm run update 需 git 仓，脚本里如实告知。
 */
test('install.ps1 falls back to codeload zip when git clone fails', () => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(root, 'install.ps1')))
  assert.match(text, /codeload\.github\.com\/litestartup-com\/hellodac\/zip\/refs\/heads\/master/)
  assert.match(text, /Expand-Archive/)
  assert.match(text, /git clone https:\/\/github\.com\/litestartup-com\/hellodac\.git/)
})

/**
 * 蜂群2计划 P6 回归：install.ps1 必须拦死 setup 的失败退出码。
 *
 * 实测现场：setup 自检 pnpm 红字 exit 2，旧脚本不查退出码，继续 build、
 * 报「完成」并开浏览器——假成功（manager 无配置直接崩）。无半成功态。
 */
test('install.ps1 aborts when npm run setup exits non-zero', () => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(root, 'install.ps1')))
  assert.match(text, /\$LASTEXITCODE -ne 0\) \{ throw 'npm run setup 失败/)
})

/**
 * 蜂群2计划 P6 回归：install.ps1 不得安装全局 pnpm——节点依赖由 setup
 * 用 npx pnpm@9 临时拉取（全局 pnpm ≥10 实测无视构建白名单）。
 */
test('install.ps1 does not install a global pnpm', () => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(root, 'install.ps1')))
  assert.doesNotMatch(text, /npm install -g pnpm'/)
})

/**
 * 蜂群2计划 P6 回归：nginx 运行时 default.conf 是生成物，绝不再进 git。
 *
 * 实测现场：线上 install.sh 在 TLS 模式下把模板 sed 进被跟踪的
 * deploy/nginx/default.conf → git pull 永远报 modified（2026-09-07 用户上报）。
 * 修法：模板改名 default.conf.example（跟踪），运行时 default.conf 由
 * install.sh 每次重跑生成并 gitignore；compose 挂载路径不变。
 */
test('nginx runtime default.conf is generated from the example, never tracked', () => {
  const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
  assert.match(installSh, /cp deploy\/nginx\/default\.conf\.example deploy\/nginx\/default\.conf/, 'install.sh 无域名模式必须从 example 生成运行时配置')
  assert.match(installSh, /"deploy\/nginx\/\$SRC" > deploy\/nginx\/default\.conf/, 'install.sh 域名模式必须从 tls-*.conf 模板生成')

  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
  assert.match(gitignore, /^deploy\/nginx\/default\.conf$/m, '运行时 default.conf 必须被 gitignore（否则线上改完又脏树）')

  const example = readFileSync(join(root, 'deploy/nginx/default.conf.example'), 'utf8')
  assert.match(example, /listen 80/, 'example 模板必须保留 HTTP 形态')
  assert.match(example, /location \/api\/internal\//, 'example 模板必须保留 H1 内网 ACL 块')
  assert.match(example, /deny all/, 'example 模板必须保留 deny all')
})

/**
 * 事故回归（2026-09-25 ubuntu-focal 失联）：join.sh 必须装 system 级 unit。
 *
 * 实测现场：旧版装 systemd **user** unit + `systemctl --user enable --now`，
 * 但从不 `loginctl enable-linger` —— user manager 只在有登录会话时存在，
 * 于是主机重启后 agent 根本没起来（`systemctl --user is-enabled` 说 enabled、
 * 开机日志里却只有别的 UID 的 user manager），节点全灭、manual 才能救。
 * 更糟的是每次 SSH 登录都会新建一个 root user manager，多个 agent 并存重复
 * 下发 node.spawn → EADDRINUSE。修法 = system unit（不依赖登录会话）+ 清理
 * 旧 user unit。
 */
test('join.sh installs a systemd system unit, not a session-scoped user unit', () => {
  const text = readFileSync(join(root, 'public/assets/agent/join.sh'), 'utf8')
  assert.match(text, /UNIT_PATH="\/etc\/systemd\/system\/\$UNIT_NAME\.service"/, 'unit 必须落在 /etc/systemd/system（开机自启的系统服务）')
  assert.match(text, /WantedBy=multi-user\.target/, 'system unit 必须挂 multi-user.target，否则开机不拉起')
  assert.match(text, /systemctl enable --now "\$UNIT_NAME"/, '必须 enable --now 起服务')
  assert.doesNotMatch(text, /WantedBy=default\.target/, '不得再生成 user unit（会话级，重启即失联）')
  assert.match(text, /systemctl --user disable --now "\$\{legacy\}\.service"/, '必须清理旧 user unit，否则 SSH 登录会再拉起一个 agent 抢端口')
  assert.match(text, /KillMode=process/, 'agent 自更新重启时不得连坐杀掉正在干活的 DSH 节点')
})

