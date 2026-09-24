// scripts/rename-to-dac.mjs —— 机械更名 sweep（B2）。
//
// 为什么要有这一步：更名触及 372 处、跨 70 个文件，手改必然漏。这里把「什么该改、
// 什么绝不能改」写成一张可复审的表，默认**干跑**（只报告，不写盘），确认后才 --apply。
//
// 用法：
//   node scripts/rename-to-dac.mjs            # 干跑：按文件/类别列出改动
//   node scripts/rename-to-dac.mjs --apply    # 真正写盘（跑完请执行全套门禁）
//
// 红线（白名单，绝不替换）：
//   - `ohdsh-api-facade`：gateway 仓库里的包名，用户拍板 gateway 保持现状
//   - `litestartup-com/dsh-api-gateway`：gateway 仓库地址（钉版链不动）
//   - CHANGELOG 的历史条目（对外条目已单独写过，历史是流水账，不改写过去）
//   - 主机名等运行期数据（如内网主机名）
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-release', 'data', '.m1-pilot'])
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|sh|ps1|cmd|html|css|conf|example|txt|Dockerfile)$/

/** 先保护、后替换、再还原：顺序即正确性。 */
const PROTECT = [
  'ohdsh-api-facade',
  'litistartup-com/dsh-api-gateway',
  'litestartup-com/dsh-api-gateway',
  // 备份加密的**格式标识**（src/crypt.ts）：`OHDSH-BAK2` magic 与 HKDF 的
  // info/salt 字串。它们不是品牌名，是已经写进磁盘密文的协议常量——改名会让
  // 既有备份永久解不开（升级不打断恢复链是硬约束）。刻意保留旧名。
  'OHDSH-BAK2',
  'ohdsh-backup-v2',
  'ohdsh-backup:',
  // 备份文件里的 v1 magic 同理（历史格式，解旧备份还要靠它）。
  'OHDSH-BAK1',
  // B2 过渡兼容：前端 ui.js 在 cutover 前必须新旧 cookie 名双读（原因见该处注释）。
  // 放进保护表而不是仅白名单：这样本 sweep 可重复运行，不会把回退分支自己吃掉。
  // 生产 cutover（B6）后删掉 ui.js 回退分支，同时删掉这一行。
  'ohdsh_csrf',
]

/** 替换表：先长后短（避免 `ohdsh-dsh-node` 之类互相吃掉）。 */
const RULES = [
  // —— 品牌 ——
  [/Oh! dsh/g, 'DAC'],
  [/ohdsh\.com/g, 'hellodac.com'],
  // —— 仓库地址 ——
  [/litestartup-com\/dsh-agent-manager/g, 'litestartup-com/hellodac'],
  // 早期手写的 `litestartup/hellodac` 少了 owner 的 `-com` 后缀（仓库真实地址是
  // `litestartup-com/hellodac`）：一并纠正。该规则不会命中上面已改好的地址。
  [/litestartup\/hellodac/g, 'litestartup-com/hellodac'],
  // 转义写法（正则源码里的 `\/`）：上面那条 URL 规则写的是字面斜杠，抓不到转义形态，
  // 2026-09-24 实撞——install-script.test.ts 两条 URL 断言漏改、npm test 红。
  // 产物保持同样的转义形态（测试里断言的正是正则源码）。
  [/litistartup-com\\\/dsh-agent-manager/g, 'litestartup-com\\/hellodac'],
  // —— 服务/任务名（Windows 计划任务 + systemd unit）——
  [/OhdshManager/g, 'DacManager'],
  [/OhdshAgent/g, 'DacAgent'],
  [/ohdsh-agent\.service/g, 'dac-agent.service'],
  [/ohdsh-agent/g, 'dac-agent'],
  [/ohdsh-start\.cmd/g, 'dac-start.cmd'],
  // —— 容器/镜像/网络/卷 ——
  [/ohdsh\/dsh-node/g, 'hellodac/dac-node'],
  [/ohdsh\/manager/g, 'hellodac/dac-manager'],
  [/ohdsh-node-brain/g, 'dac-node-brain'],
  [/ohdsh-nginx/g, 'dac-nginx'],
  [/ohdsh-manager/g, 'dac-manager'],
  [/ohdsh-hive/g, 'dac-hive'],
  // compose 项目名推导出的默认前缀（`ohdsh_hive`）：`\b` 在 `_` 前不算边界，
  // 兜底规则抓不到——干跑残留报告逮到的第一处就是它。
  [/ohdsh_hive/g, 'dac_hive'],
  [/ohdsh-brain/g, 'dac-brain'],
  // —— 磁盘路径与 profile 名 ——
  [/\.dsh-ohdsh/g, '.dac'],
  [/dsh-profile-ohdsh-node/g, 'dsh-profile-dac-node'],
  [/profiles\/ohdsh-node/g, 'profiles/dac-node'],
  [/\/opt\/ohdsh/g, '/opt/dac'],
  // —— cookie ——
  [/ohdsh_csrf/g, 'dac_csrf'],
  // —— 环境变量（DSH_* 属上游语义，保留）——
  [/OHDSH_/g, 'DAC_'],
  // —— 发布物 ——
  [/ohdsh-compose\.zip/g, 'dac-compose.zip'],
  // —— 包名与其余标识（兜底，放在最后）——
  [/package name `ohdsh`/g, 'package name `dac`'],
  [/`ohdsh`/g, '`dac`'],
  [/"name": "ohdsh"/g, '"name": "dac"'],
  [/\bohdsh\b/g, 'dac'],
]

/** 文件级白名单：整份跳过（历史流水账 / 本地笔记 / 本脚本自身）。 */
const SKIP_FILES = new Set([
  'CHANGELOG.md', // 历史流水账，不改写过去
  'CONTEXT.md', // 本地会话笔记（未入库）
  'RULE.md', // 本地开发规约（未入库）
  'scripts/rename-to-dac.mjs', // 本脚本：规则里就写着 ohdsh，替换自己会自毁
  // release-check 的「旧品牌名清零」必须**照着旧名**扫（扫描正则 + 白名单），
  // 被替换就等于把守卫自己拆了：2026-09-24 实撞——`/ohdsh/i` 被改成 `/dac/i`，
  // 守卫一度把全仓含 dac 的文件都报成违规。
  'scripts/release-check.mjs',
])

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full)
    else if (TEXT_EXT.test(entry) || entry === 'Dockerfile' || entry.startsWith('Dockerfile.')) files.push(full)
  }
}
walk(root)

let totalHits = 0
let changedFiles = 0
const byRule = new Map()
const report = []
const leftovers = []
// 「转义写法」嫌疑：定向规则写的是字面量（如 `ohdsh/dsh-node`），而代码里为了写正则
// 常写成 `ohdsh\/dsh-node`——斜杠被转义，定向规则抓不到，只能落到兜底 `\bohdsh\b`
// 上，于是 `hellodac/dac-node` 被误改成 `dac/dsh-node`（2026-09-24 实撞：3 处）。
// 双向都报：改前查旧名的转义写法，改后查产物里的 `dac\/`/`dac\.` 形态。
const suspects = []
let suspectsScanned = 0

for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/')
  if (SKIP_FILES.has(rel)) continue
  const original = readFileSync(file, 'utf8')
  let text = original
  // 0) 改前嫌疑：旧品牌名/旧仓库名后跟转义分隔符
  const escaped = original.match(/(?:ohdsh|litistartup-com)\\[[/._-]/gi)
  if (escaped !== null) suspects.push(`  ${rel}: 旧名转义写法 ×${escaped.length}（定向规则可能抓不到，务必人工核对产物）`)
  // 1) 保护白名单（换成不可命中的占位符）
  const guards = PROTECT.map((needle, index) => {
    const token = `\u0000GUARD${index}\u0000`
    text = text.split(needle).join(token)
    return { token, needle }
  })
  // 2) 规则替换
  const fileHits = []
  for (const [pattern, replacement] of RULES) {
    const matches = text.match(pattern)
    if (matches === null) continue
    text = text.replace(pattern, replacement)
    fileHits.push(`${pattern.source} ×${matches.length}`)
    byRule.set(pattern.source, (byRule.get(pattern.source) ?? 0) + matches.length)
    totalHits += matches.length
  }
  // 3) 还原白名单
  for (const { token, needle } of guards) text = text.split(token).join(needle)
  // 替换后的残留检查：只看替换结果（干跑时磁盘还是旧内容，读盘会骗人）。
  let masked = text
  for (const needle of PROTECT) masked = masked.split(needle).join('')
  const leftoverHits = masked.match(/ohdsh/gi)
  if (leftoverHits !== null) leftovers.push(`  ${rel}: ${leftoverHits.length}`)
  // 改后嫌疑：产物里 `dac\/`、`dac\.` 形态 = 兜底规则的痕迹（正确应为 hellodac\/…）。
  // 负向环视排除 `hellodac\/`（正确产物自身也含 `dac\/` 子串，否则全是假阳）。
  const mangled = masked.match(/(?<!hello)dac\\[/.]/g)
  if (mangled !== null) {
    suspectsScanned += mangled.length
    suspects.push(`  ${rel}: 产物疑似被兜底规则误改 ×${mangled.length}（${mangled.slice(0, 3).join(' ')}）`)
  }
  if (text !== original) {
    changedFiles += 1
    report.push(`  ${rel}  (${fileHits.join(', ')})`)
    if (APPLY) writeFileSync(file, text, 'utf8')
  }
}

console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${changedFiles} 个文件、${totalHits} 处替换`)
console.log('\n按规则：')
for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${rule}`)
}
console.log('\n按文件：')
console.log(report.join('\n'))

// 干跑也报告残留：白名单（gateway 包名/仓库地址/本脚本/历史）之外不该再有 ohdsh。
console.log(`\n替换后仍含 ohdsh 的文件（应只剩白名单相关）：${leftovers.length}`)
console.log(leftovers.slice(0, 20).join('\n'))

// 转义写法嫌疑：这条报告非空就必须逐个人工核对，别信 "0 残留"。
console.log(`\n转义写法嫌疑（需人工核对）：${suspects.length} 个文件、产物形态 ${suspectsScanned} 处`)
console.log(suspects.slice(0, 20).join('\n'))
if (!APPLY) console.log('\n（这是干跑；确认后加 --apply）')
