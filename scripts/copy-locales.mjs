// scripts/copy-locales.mjs —— 把语言包拷进 dist。
//
// 为什么需要这一步：`tsc` 只编译 TS，不搬 JSON；而 manager 容器镜像只拷
// `dist`（见 images/manager/Dockerfile），运行期 `dist/i18n/index.js` 就找不到
// `dist/i18n/locales/*.json` 而启动失败——2026-09-24 实测（第一次带 i18n 的
// 构建在本机就炸了 ENOENT，正好说明这一步不能靠"记得手动拷"）。
//
// 单一真相源仍是 src/i18n/locales/*.json；本脚本只做派生。
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'src', 'i18n', 'locales')
const to = join(root, 'dist', 'i18n', 'locales')

mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true })
console.log(`[copy-locales] ${from} → ${to}`)
