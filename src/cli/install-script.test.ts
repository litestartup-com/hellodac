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
