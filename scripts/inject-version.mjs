// scripts/inject-version.mjs — 债务 D5:版本号构建期注入。
// package.json 是唯一真相源;本脚本把 version 写进 src/version.ts(build /
// preversion 时运行),gen-env.sh / make-release / /api/status 全从这条链读。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const out = `// 生成文件,勿手改:构建期由 scripts/inject-version.mjs 从 package.json 注入。
// 债务 D5:manager 自身版本的运行时真相源(DSH 兼容版本见 dsh-matrix.ts,两者勿混淆)。
export const MANAGER_VERSION = '${pkg.version}'
`
const target = join(root, 'src', 'version.ts')
let before = null
try {
  before = readFileSync(target, 'utf8')
} catch {
  // 首次生成
}
if (before !== out) writeFileSync(target, out, 'utf8')
console.log(`[inject-version] MANAGER_VERSION = ${pkg.version}`)
