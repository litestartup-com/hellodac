# Changelog

## v1.0.0 — first public release (2026-10-01)

**One Manager. A Fleet of Agents.** The first public release of DAC (Dispatched Agent
Cluster), an MIT control plane for fleets of containerized agent nodes across servers.

What ships in 1.0.0:

- **Fleet management** — one manager, machines joined by a node agent (Linux `join.sh` with a
  systemd system service, Windows `join.ps1` with a scheduled task), nodes as container workers or
  host processes, with start/stop/restart/logs, per-node DSH version pinning, and a live
  topology view (manager → machines → nodes, heartbeat edges).
- **Unified conversation** — streaming chat against any node, tool cards, inline question and
  approval handling, per-session model selection and access-mode switching
  (`read-only` / `workspace-write` / `danger-full-access`), conflict surfacing when two turns
  commit the same workspace.
- **API access** — the gateway plugin exposes each node's agent through one authenticated
  prefix, so third-party clients get the same agents the UI has.
- **Operations** — audit log, peak/off-peak costing with daily budget breakers, encrypted
  backups with a restore drill, self-update with health probe and automatic rollback,
  in-app notifications for offline machines and abnormal nodes.
- **Bilingual UI** — English by default, Chinese switchable per user; new languages are one
  JSON file plus one registry line.
- **Safe defaults** — node ports bind loopback only, the node agent is zero-native-dependency
  and outbound-only, dangerous operations are gated by approval cards, agent tokens rotate
  with a 30-minute grace window, first login forces a password change.

Changes made *for* the public release, relative to the pre-release internal line:

- Renamed the product to **DAC** (was "Oh! dsh"); repository and images follow
  (`hellodac/dac-manager`, `hellodac/dac-node`).
- Removed two half-finished pages from the UI: the per-agent board view and the scheduled-jobs
  page. Both back ends remain (the board feeds brain output, the scheduler API still runs
  unattended work) — only the unfinished surfaces are gone.
- Made English the default language and moved every user-visible string into translatable
  locale files (UI, API error details, notification text, CLI output, workspace templates).
- Added `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and PR templates.

Hardening and UI polish landed on the public line before the tag (2026-09-25/26):

- **Fleet reliability** — the node-agent now installs as a systemd *system* service (the
  user-unit form never started on boot and raced itself on every SSH login); node spawn is
  idempotent so reconcile sweeps cannot double-start a node, and a machine's nodes resume
  from disk on their own after a reboot without waiting for the manager. Verified on a
  clean machine: join → reboot → nodes back in seconds, zero manager involvement.
- **Language switching actually works** — `?lang=` was processed after the auth guard on
  protected pages, which swallowed the cookie before the redirect; the switch now runs as a
  global request hook ahead of every preHandler.
- **Nodes UI decluttered** — a row now shows status, id, owner and running version, with
  start/stop/restart, version switching, logs and native access moved into a ⋮ menu; the
  sidebar overflow menu became a fixed two-level structure with Language and About as
  flyouts; run summaries clamp to two lines with expand/collapse.
- **Audit & password pages restyled** — the audit log is a hairline timeline with semantic
  state dots instead of stacked cards; the password page's submit button is deep ink rather
  than accent blue (the login button stays blue).
- **Docs & polish** — product screenshots in both READMEs; the tagline split from the
  description; the sidebar tagline localized (统一调度的智能体集群 in Chinese); icon
  spacing, a proper mail glyph and an inline copy bubble in the About flyout.
- **Guards** — new tests pin the anchor-vs-button contract, icon-sprite names, DOM wiring
  against the built pages, the password-button colour contract, the view-switch contrast,
  and the `?lang=` hook ordering, so these regressions fail in CI rather than in a browser.

## 未发布（1.1.2 候选 · 升级零手改配置，2026-09-22）

- **配置版本化迁移（P0）**：`manager.config.yaml` 增 `config_version` 字段 +
  `src/config/migrations.ts` 迁移链（0 → CURRENT 逐级 +1）；loadConfig 在解析
  前自动迁移旧配置——写回前原文件备份 `.pre-mig.bak`、迁移说明进 warnings
  （boot 日志可见）、版本超前/链断裂 fail-loud；check-docs 常驻断言迁移链
  覆盖完整（改结构忘配迁移 = CI 红）
- **节点切版本 API + 页面下拉（P1/P2）**：`POST /api/nodes/:id/version` 双分支
  ——进程 = 改钉版 + 对齐链（与 align-version 共享实现）；容器 = 改镜像 tag +
  立即重建（补上容器节点 409 无替代入口的缺口）；审计 `node_version_change`；
  节点行「DSH 版本」下拉（矩阵数据源，pending 标注），切版本全程零 sed
- **能力四 · 舰队 M1（node-agent 多机形态）**：设计稿 `fleet-agent-architecture.md`
  Q1–Q5 拍板后按 `plan-fleet-agent.md` 落地——`spawn.runner=agent + host` 配置
  真相源；agent 注册链（一次性 join token 换发身份、token 哈希落库、吊销）；
  指令队列与事件通道（DB 持久化、长轮询领取、结果/心跳/日志回报、90s 在线
  判定）；supervisor agent 分支（远端生命周期走指令队列，spawn 结果订阅快速
  失败链）；node-agent 进程本体（零原生依赖、DSH 钉版装自有 prefix、失联退避
  自愈、401 清身份重注册；join.sh/join.ps1）；派生下发（profile/种子/fleet.md
  随 spawn 载荷送达，幂等落盘）；机器页 UI（agent 目录 + join 命令 + 节点
  主机列 + 向导主机下拉）。修复：profileDependencies 展开顺序 bug（0.1.5
  节点拿 0.1.2 bundles）、微任务饥饿（瞬时 resolve 链饿死定时器）。
- **能力四 · 舰队 M1 本地试点与三连修复（2026-09-23）**：M1 本地试点在
  Windows 本机跑通全链（agent 注册 → 机器区现身 → API 建 agent 节点 →
  facade live → 聊天回合 → 起停/重启/日志），过程中实证并修复三类问题：
  1. **Windows 平台双坑**——agent 的 `execFileSync('npm')` 无 shell 直接
  ENOENT（npm 是 .cmd 垫片）、`spawn(bin.js)` EFTYPE（CreateProcess 无
  shebang），均改为平台感知调用（shell: true / win32 经 node 执行）；
  2. **0.1.5 家族浮动区间 + legacy 跳 peer 双杀**（事实卡 dsh-facts §14）——
  dsh@0.1.5-rc.2 依赖全是 `^` 浮动区间，registry 已发 0.1.5-rc.3，新装整树
  漂移且 `--legacy-peer-deps` 跳过全部 peer → 启动即崩；修复 = profile 随送
  package-lock 整树快照（profile-locks.ts）+ 26 个显式 peer 钉版
  （LEGACY_PEER_PINS，profile.ts 与容器生成器逐字同步）+ `patchReload:
  startup`（免 HMR 硬依赖）+ agent 优先 profile-local bin；
  3. **agent 节点就绪窗 30s → 120s**（远端首启 = 依赖安装 + 全量 boot，实测
  40~90s）；兼容性信号改走版本矩阵（0.1.5-rc.2 verified 行不再误报不兼容）。
  试点另证实：worker agent 节点无模型凭据（设计如此，凭据下发属 M3），
  同机复制 `.credentials.yaml` 后聊天回合即通。
- **能力四 · 舰队 M3-3 告警提前（§13 补丁，2026-09-23）**：fleet 看门狗
  （`src/fleet/watchdog.ts`）30s 一轮——agent 心跳超时（90s）与 agent 节点
  监督器 offline 边沿触发进站内铃铛（`agent_offline` / `node_offline`，恢复
  再报 `*_recovered`）；未读去重防 manager 重启刷屏；只报 agent runner 节点，
  本机 process/docker 节点不越界。本地实测：停 agent 任务 → 铃铛
  「机器掉线」；重启任务 → 「机器恢复」。
- **能力四 · 舰队 M4-1 agent token 轮换（2026-09-23）**：
  `POST /api/agents/:id/rotate`（机器页「轮换密钥」按钮）——仅在线机器可轮换
  （离线 409 防打砖）；新 token 只经 `config.deliver` 指令投递给 agent
  （不回传浏览器）；旧 token 进 30 分钟宽限位（ack 丢失不砖机），agent 报
  成功才清宽限、报失败自动回滚；迁移 18（prev_token_hash/prev_set_at）+
  审计 `agent_token_rotated`。本地 E2E：轮换 → agent 身份落盘换新 → ack
  收敛 → 新 token 心跳续命。
- **能力四 · 舰队 M3 ops 节点开锁（2026-09-23）**：danger-full-access 工作区
  → spawn 载荷带 `ALLOW_FULL_ACCESS` → agent 写 facade settings
  `allowFullAccess: true`（facade 侧风险告警日志兜底）。192.168.33.11 实测：
  ops33 节点 host.describe 报 `allowFullAccess: true`，聊天能力面
  fullAccess 解锁（composer accessMode=danger-full-access）。审批卡片链路为
  facade 既有机制；真实卡片回合待该机放置模型凭据（凭据口径属 M3 验收）。
- **能力四 · 舰队 M2 跨机试点（2026-09-23，192.168.33.11 实测）**：Linux
  机器经 join.sh（systemd user unit）接入本机 manager——跨机节点 spike02
  （0.1.5-rc.2）创建/探活 live/日志流/起停/断连恢复（agent 停起 → 铃铛
  掉线恢复 + 节点存活 + 对账收敛）/facade 防火墙白名单（ufw 只放行 manager
  出口 IP，非白名单源实测拒绝）。过程中修复 4 个真 bug：① 就绪探活延后到
  spawn 结果后（冷安装不被 120s 窗误杀，此前会 stop+重试风暴）；② agent
  安装完成标记（.installed-ok）跳过 warm 重装（慢盘重装分钟级）；③ join
  脚本 Node 门禁 ≥22.18（DSH 0.1.5 启动器依赖 import.meta.main，22.17 上
  节点拉起即死、日志空——静默退出 0 实证）；④ agent 节点远端工作区路径
  原样透传（Windows resolve 把 /root/... 拧成 C:\root\...，facade 拒收
  非绝对 cwd）。聊天回合链到模型层（凭据缺失为设计预期，凭据口径属 M3）。
- **能力四 · 舰队 M4-4 指标采集（2026-09-23）**：agent 每 60s 随心跳上报
  主机指标（CPU 忙占比 ×10 整数、内存/磁盘总量与用量、运行时长、平台）——
  CPU 用两次采样间差值（`os.cpus()` 时间片），磁盘走 `fs.statfs`；manager 落库
  （迁移 20 `agent_metric`，7 天保留自动清理）、`GET /api/agents/:id/metrics`
  趋势端点（≤1440 点）、机器行展示最新快照（CPU/内存/磁盘占比）。红绿 2 例
  + 本地 E2E（真实 agent 两轮采样：CPU 差值 1.4% 落库并进快照）。
- **能力四 · 舰队 M4-3 agent 自更新原子性（2026-09-23）**：
  `POST /api/agents/:id/update`（在线门禁）把 manager 静态面的
  agent.mjs/runtime.mjs/update.mjs + 排序拼接 sha256 打成 `agent.update`
  指令；agent 校验后 staging 到 `.next` → 以非零码退出（Windows 批处理
  5s 重启循环兜底，systemd Restart=always 天然支持）→ 启动期原子换装
  （当前 → `.prev` 保留一代）→ 新代码加载；**秒崩自动回滚**：90s 内重启 +
  换装 10 分钟内 + 上一代存在 = 新代码崩溃循环 → 恢复 `.prev`；版本协商 =
  注册/心跳上报 agentVersion（迁移 19），机器页「待更新」徽标对比
  managerVersion。本地 E2E：自动更新 → v1.1.1 生效；注入坏 runtime → 秒崩
  → 自动回滚 → 机器恢复在线。
- **能力四 · 舰队 M4-2 日志限额与背压边界（2026-09-23）**：agent 侧
  `node.log` 上限 50MB——spawn 前超限自动轮转（保留一代 `.1` 供崩溃排障，
  Windows 上旧 fd 已关闭时 rename 安全）；README 双语新增「规模与背压边界」
  一节（通道限流矩阵 / 日志限额 / 单 manager ≤50 台建议与依据）；
  check-docs 守卫 `NODE_LOG_MAX_BYTES`。
- **能力四 · 舰队 M3-1 ops 节点（2026-09-23）**：向导/API 放行第三档沙箱
  `danger-full-access`（整机全量，Q2 拍板口径）——provision schema 档位 +
  向导下拉（高危标注）+ 独立黄字确认（审批卡片/审计/凭据口径）；check-docs
  三件套守卫；README 双语补「运维助手节点（ops）」部署配方（布放规则 D3、
  审批卡片兜底、服务器本地凭据不经 manager 下发、节点侧 allowFullAccess
  开锁）。

## 1.1.1 — 线上验收修复三连（2026-09-20）

- **线上磁盘教训**：15 分钟自动快照 + 节点家目录打包在小盘线上吃满磁盘——
  `backup.auto` 默认**关闭**（`manager.config.yaml` 显式 `auto: true` 才开）；
  手动 `npm run backup` 与更新前备份不受影响
- **目录搬家自愈**：install.sh 每次运行都把 `host_volumes` 的宿主侧工作区路径
  重钉到当前安装目录（评审 B2 的泛化——旧实现只在首次创建时钉一次，搬家后
  会指向旧目录）。现在**任意目录安装 + 搬家后 `cd` 进去重跑 `bash install.sh`
  即收敛**；check-docs 加搬家重钉守卫
- **容器形态拒绝宿主机进程节点**（线上实测教训）：manager 镜像内置
  `OHDSH_DEPLOY_FORM=container` 标记——provision 对显式 `runner: process`
  返回 400 `host_process_unavailable`（原来得到的是「找不到 bin.js」的误导性
  报错），向导同步禁用「宿主机进程」选项；裸机部署（含混合 docker.sock
  部署）无标记不受限

## 1.1.0 — 节点三能力 · 隧道直开 / 宿主机节点 / 多版本（2026-09-20）

> 设计/计划：`hive/nodes-install-version-tunnel.md`、`hive/plan-node-capabilities.md`；
> 依据事实：S0 spike（dsh-facts §11）——nginx 域名反代被上游 loopback 钉死面
> （PRIVILEGED_METHODS / dynamicCordisRunner）否决，原生 GUI 全功能通道 =
> 用户侧 SSH 隧道（浏览器即 loopback）。

- **能力三 v1**：配置真相源 `endpoints.*.access`（ssh_user/ssh_host/ssh_port/
  gui_port/local_port，缺省 22/3080）——manager 只记「怎么连」，**SSH 私钥永不进
  配置**；`POST /api/nodes/:id/access` 写回（锁+原子写+审计 `node_access_update`+
  clear 移除）；节点页「原生 GUI」卡：隧道命令 + 复制 + 一键打开，0.1.5 的
  `?token=` 从节点日志（buffer/docker/file 三源）即时捕获、重启轮换自动跟随；
  节点 GUI 端口只发布宿主机 loopback（compose node-brain + 动态工蜂
  PortBindings 127.0.0.1）。体验优化（验收反馈）：隧道命令加 `-N`（纯隧道）+
  `-o ExitOnForwardFailure=yes` + 可选 `ssh_key` 私钥路径（`-i`，只存路径不存
  密钥）；**本机 loopback 节点免隧道**——卡片直接「本机直连」打开（URL 用节点
  启动行自报端口 + token）
- **能力一 · 宿主机节点安装**：profile 生成/安装/钥匙/依赖命令抽公共模块
  `src/host-node/`（setup 与 provision 共用）；profile 依赖新增
  `@deepseek-ai/dsh` 自身——隔离安装后 spawn 优先用 profile 内 bin.js
  （回退全局，存量兼容）；向导形态选择「自动 / 容器工蜂 / 宿主机进程」，
  宿主机进程黄字确认 + 审计 `node_create_host`，显式 docker 但未挂 sock 时 400
- **能力二 · 节点级多版本 DSH**：`src/dsh-matrix.ts` 版本矩阵（(dsh ↔ facade)
  配对表，唯一真相源；`src/dsh-version.ts` 退化为 re-export 垫片）；矩阵两行
  0.1.2-rc.1 / 0.1.5-rc.2 均已 **verified**——0.1.5 经服务器 smoke15 全链
  smoke（host.describe 合成版本 / session.create / session.prompt 真实回合 /
  mux 帧流 user→assistant→turn/end；安装需 `--legacy-peer-deps`、运行时需
  node ≥22.19，事实卡 dsh-facts §12）；向导/API 支持 `dsh_version` 按节点钉版
  ——profile 钉目标版本、yaml 仅显式设置才落盘（默认跟随矩阵首行，不冻结）、
  未知版本 400、pending 配对黄字警告；节点页显示配置版本 + 漂移探测 +
  `POST /api/nodes/:id/align-version` 一键对齐（reseed→installDeps→隔离 bin
  重启，审计 `node_align_version`，容器节点 409 显性拒绝）；容器镜像随钉版
  `ohdsh/dsh-node:<dshVersion>`；`profileInstallCommand`/后台安装按矩阵配对自动
  追加 `--legacy-peer-deps`（0.1.5 ERESOLVE 修复，dsh-facts §12）；升级脚本泛化
  `scripts/upgrade-node-version.mjs`（目标版本参数化、幂等、`--dry-run`、备份
  `.pre-<version>.bak`、`.env` 镜像 tag 同升），旧 `upgrade-012-win.mjs` 留兼容壳，
  check-docs 守卫升级为「脚本 SUPPORTED 表与矩阵逐行对齐」断言。UI 面补全
  （验收反馈）：节点行「版本漂移」黄标 + 「对齐版本」按钮（确认→202 受理）；
  向导「DSH 版本」下拉（数据源 = GET /api/nodes 的 supportedDsh，不前端硬编码），
  显式钉版在节点行展示「钉 x.y.z」

## 1.0.4 — 安全修复 + 四批技术债清偿（2026-09-12）

> ⚠️ **升级注意**：
> - `engines` 收紧为 **Node ≥ 22**（better-sqlite3 13 要求）——旧 Node 升级会被拒，先升 Node；
> - 升级后首次启动 `.env` 经 zod 集中校验，`SESSION_SECRET` 不足 32 位等会 fail-loud 拒绝启动；
> - 备份产物改为密文：新备份 DB 快照为 `<file>.db.enc`、`.env` 为 `.env.enc`（GCM 加密）；
>   旧明文快照仍可恢复（兼容读），但**新备份不再落明文**。

### 安全与数据正确性（第一批 · 发布门修复，R1–R10 + S3）

- **R2 备份加密**：DB 快照与 `.env` 全走 AES-256-GCM（临时目录中转，崩溃不留明文）；restore 按 `.enc` 分流解密，篡改必失败
- **R3/R4 备份走真相源**：backup/update CLI 的 DB 路径/备份目录/探活端口全来自 `loadConfig()`；配置副本明确「仅供人工参考」，不再宣称完整恢复
- **R5 mux 首连判据**：以真实 `onopen` 为「曾连接」事实，首连失败不再误广播重连（修掉 run 被错标「结果未知」的计费链 bug）
- **R6 配置写锁全路径**：provision/setup/auth 的配置写全过 `withConfigLock`；YAML `doc.errors` 输入+回读双查
- **R7 治理规则透传**：`applyWrites` 落盘后二次校验用与写前同一份 agent 规则（不再退化为 DEFAULT_RULES）
- **R8 apiproxy 订阅泄漏**：prompt 拒绝/抛错/超时全部 try/finally 退订；`finish` 幂等闸
- **R9 对账单一化**：provision 热变更全走 `reconcileAll`（onlyNodes 范围化，不抢拉用户手动停掉的冷节点）
- **S3 变更端点全量限流**：nodes 起停/增删 20/min、internal 派工/续写/crons 60/min、改密 10/min 与登录同档
- **R10 发布门补丁**：`gen-env.sh` 写入 `HOST_UID/HOST_GID`（compose 容器与部署用户同 uid）——此前跳过 install.sh 直接用 gen-env 的场景（CI compose-e2e）容器回落 1000 而宿主文件属 1001，manager 写不进 data → `SQLITE_CANTOPEN` 死循环、nginx 全 502；节点镜像 `/data` 卷根 777 + `HOME=/data`——容器按 HOST_UID 运行而命名卷继承镜像 1000 属主时，`mkdir /data/profiles` EACCES、节点无限重启、工蜂认领超时；manager 镜像 `/app` 目录放写——真相文件原子写（`.tmp`+rename）要求目录可写，否则动态开通写 `/app/.env.tmp` EACCES 500；`writeFileAtomic` 加 EBUSY 回落——文件级 bind mount（`./.env:/app/.env`）在 Linux 上不能被 rename 顶替，rename 失败回落原地写（与 auth.ts 清初始口令同款取舍，注入 rename 回归测试）；**provision 新建端点切 0.1.2 facade 主路**——旧 0.1.1 接线（`prefix:/api` + `key_ref:''`）探活 host.describe 401，新节点永远 live 不了（compose-e2e worker live 超时实证；yaml 与内存端点、docker/process 两分支同修，key_ref=GW_KEY_<名> 与 sandbox 同一把钥匙）；**节点卷备份/恢复改 attach 流式传输**（`runToolIo`）——旧实现把 manager 容器内的备份目录当宿主路径 bind，dockerd 按宿主语义解析到幽灵目录，tar 产物读不到（ENOENT）；现在只绑命名卷、数据走 stdin/stdout 流，`tar czf -`/`tar xzf -`（docker-runner 3 例 + nodebackup 桩 1 例回归）
- **E8 协议帧判别收紧**：RPC/mux/translate 六帧型 zod 判别（形状不符 fail-loud 丢弃，不猜上游）
- **卡片丢失链修复（2026-09-17，生产实证：卡片偶发不显示、ask_user_question 卡住）**：根因 = question/approval 帧是**一次性广播、无恢复通道**——facade 只在问题出现的瞬间广播一次，mux 断线窗口/manager 重启/SSE 断流任何一环错过就永久丢卡。修复五件套：① runner 重连时若正等人作答（awaitingHuman>0）不再杀回合（问题挂起时回合必然未结束，答案经 respond 独立送达）；② 挂起卡片（pendingCards）独立于回合生命周期持久化，GET 刷新与 SSE 重连（hello 后）均重放，resolved 或 15 分钟 TTL 清理；③ 应答/决断成功即合成 resolved 帧（不依赖上游广播，卡片必关）；④ **facade 恢复通道**：answerer 留存挂起载荷 + `GET /api-gw/v1/answerer/pending`（gateway commit `b592b4f` 钉入），manager 新增端口能力 `pendingAsks`——回合开始、mux 重连、GET 刷新三处按需取回断线窗口/重启前丢失的卡片帧（按 rpcId 去重）；⑤ mux 帧丢弃/断线/重连全部留日志（`setMuxLogger` → app.log）。红绿 7 例（runner 2 / mux 2 / chat 3）

### 后端疗程（第二批）

- **E1–E4 巨型模块拆分**：runner（回合状态机 `runner/turn.ts`）、chat（relay/回合编排/CRUD 三层）、provision（四段开通流水线）、setup（六阶段 main）各自收窄
- **E9 usage 聚合 drizzle 化** + 钱字段 API 统一 MicroUsd 命名（不再泄露裸列名 cost/peakCost）
- **E16 三份 ADR**（回合驱动语义 / usage 两规则 / chat 回合计数复盘）+ wire 现实迁事实卡 `dsh-facts.md` §9

### 前端疗程（第三批）

- **F1 chat.js 拆五模块**（reducer/render/wire/composer/state，2146 → 876 行）+ 前端测试 80 例
- **F6 apiJson 统一 Result 层**：八页「status 判断 + 读 JSON + 拼 banner」样板清零，错误 banner 共享且自动转义
- **F3/F4** SSE 重连与轮询收口（autoReconnect / poll）；**F5** 全站唯一未转义 innerHTML sink 修复；**F7** ui.js 开启 @ts-check 进 CI typecheck

### 测试与工具链（第四批）

- **C3 共享测试 harness**：13 个测试文件重复 helper 收敛；mux 重连测试 mock 时钟（省 12s）；supervisor 测试全程假进程（不再真起 node -e）
- **C4 coverage 门禁**：只统计生产代码，lines 80 / branch 70 / funcs 75 进 CI
- **D4 依赖追平**：better-sqlite3 13 + zod 4 + @types 9.6.0
- **D5 版本号构建期注入**（/api/status 暴露 managerVersion）+ env 集中 zod 校验 + exactOptionalPropertyTypes 收紧

## 1.0.3 — 0.1.2 切主路（2026-09-10）

> ⚠️ **升级注意**：切主路升级顺序 = **先停栈 → 跑 upgrade 脚本 → 重启 → smoke**。
> 脚本首次运行自动备份 `*.pre-012.bak`（含 `.env`，不入库），出错按备份回滚。
> Linux 容器：`node scripts/upgrade-012.mjs`（manager.config.yaml 接线 + .env 镜像标签）；
> Windows 裸机：`node scripts/upgrade-012-win.mjs`（profile 换 facade / 铸钥 / .env 同步 / 全局 DSH，
> 端口预检被占即拒）。

### 修路（manager 上层重写）

- **SessionDriver 端口化**：上层只依赖端口，facade 驱动成为插头（探活改 probeVersion、release 语义入端口，零行为变化）；拔插头验收 FakeSessionDriver 纯内存驱动 apiproxy 全链路 8 条测试
- **ACP 窄桥**：SDK 客户端中继 + 窄面映射（权限→审批帧；usage/history 缺口入档），假 agent 验收 4 条 + runner 拔插头复跑
- **对账单一化**：reconcileAll 统一入口（镜像/run 收敛/孤儿/fleet/节点认领），boot 与 provision 共用；healOnly 只治 offline；supervisor 运行时健康对账（probeLive 连续失败转 offline，同 tick 自愈）
- **apiproxy prefix 显式配置生效**：0.1.2 facade 接线的先决条件（省略时保留旧默认 /api）

### 0.1.2 切主路

- COMPAT_DSH_VERSION 升 `0.1.2-rc.1`，gateway 0.1.2 门禁化改包名 **ohdsh-api-facade** 全线接线（镜像 / 节点 profile / entrypoint 命名空间 / 默认 tag），endpoints 走 `/api-gw/v1/proxy` + key_ref（与 sandbox_key_ref 同一把钥匙）
- **upgrade-012.mjs**：manager.config.yaml 一次性接线迁移（幂等 / 备份 / 缺钥匙退出码 2 大声失败）+ `.env` 镜像标签迁移（`DSH_NODE_IMAGE→0.1.2-rc.1`、`MANAGER_VERSION→1.0.3`，gen-env 幂等不覆盖旧值所以必须显式升）
- **upgrade-012-win.mjs**：Windows 裸机节点升级（profile 换 facade / 铸钥 / .env 同步 / 全局 DSH），端口预检（8080/3081/3082/3090 被占即拒，EPERM 半毁树教训固化）、`--dry-run` / `--force`、幂等
- 节点 profile 依赖安装 **pnpm→npm**（pnpm@9 预发布区间失效 + pnpm@11 白名单失效，双墙实证；npm 同版本集本机 e2e 全绿）
- Windows setup resolveGatewayKey 切 facade 命名空间（旧 dsh-api-gw 段不读，含回归测试）
- entrypoint 密钥判定加命名空间条件（0.1.1 旧 settings.yaml 残留同 key 串不再误判跳过）
- compose 删 `--trusted-host`（0.1.2 CLI 已删）；镜像 stage-2 用户创建兼容已有 1000:1000
- **双线验证**：Linux 容器集群 + Windows 生产节点 smoke 全 PASS（三节点 apiKeySet:true）
- 文档双语规范落地：README.md（英文）+ README.zh.md（中文）分文件，禁止混排

## 1.0.2 — 安全与部署加固（2026-09-08）

> ⚠️ **升级注意**：本版数据库迁移会把既有账号的 `must_change_password` 置 1——升级后首次登录
> 强制改密。请确认你记得当前密码、或 `.env` 里 `MANAGER_INITIAL_PASSWORD` 仍在；两者都丢失的
> 用户将被锁死（当前无重置途径，只能重建 `data/manager.db` 并丢失运行历史）。

### 安全

- **H1 manager 容器非 root + docker.sock 组级降权 + nginx 内网 ACL**：manager 镜像内建 `USER 1000:1000`；compose 以 `HOST_UID:HOST_GID` 运行并经 `group_add` 注入宿主 docker 组 GID（`DOCKER_GID` 由 gen-env.sh 探测写入 .env）；install.sh 按 HOST_UID 放行 `.env`/`manager.config.yaml`/`data`/`workspaces`；四个 nginx 模板对 `/api/internal/` 加私网 ACL（token 之外的第二道门）。注意：部署用户为 root（HOST_UID=0）时容器仍为 root——完整收口需 socket-proxy/rootless docker（后续）
- **H2 provision 全量回滚**：副作用重排为「准备 → DB → 真相文件 → 内存 → 进程」，任一步失败按相反顺序撤销，杜绝半开通幽灵节点；审计记录失败尝试
- **H3 fleet.md 提交收窄**：`git commit -- fleet.md` 路径限定（用户已 staged 的其它改动绝不被捎带）+ 每 agent 提交锁，不再互踩 index.lock
- **登录限流不再信任转发头**：trustProxy 收紧，轮换 X-Forwarded-For 绕过已封堵（回归测试实证）
- **helmet + CSP `script-src 'self'`** 全套安全头（HSTS 仅 TLS 形态），与前端逐条核对零冲突
- **改密吊销其它会话** + `.env` 抹除初始口令（配合首登强制改密与 CSRF 自愈）
- **BRAIN_TOKEN 落点 `$HOME/.brain-auth`**（0600，不进工作区/不随 git 流动）

### 部署

- **nginx 运行时 default.conf 改为生成物**：模板改名 `default.conf.example`，install.sh 每次重跑生成，gitignore 排除——线上 git pull 不再报 modified。老部署升级：`git checkout -- deploy/nginx/default.conf && git pull`，然后重跑 `bash scripts/gen-env.sh .env`（补 DOCKER_GID）并 `docker compose restart nginx`
- CI 扩展：lint + 前端测试（md.test 进 CI）+ 部署门禁（manager 非 root / group_add / nginx ACL 断言）

### 回归测试

- `fleet-doc.test.ts`：用户预 staged 文件不得进入 manager 提交的断言
- `provision.test.ts`：DB 写入失败 → 六面（内存/监督器/yaml/.env/目录/DB）零残留断言
- `scripts/check-docs.mjs`：manager 镜像 USER、compose group_add/DOCKER_GID、nginx internal ACL 的部署门禁

## 1.0.1 — 产品级单机版（蜂群2计划，2026-09-05）

从「功能 v1」到「产品级 v1」：一键安装、容器化、安全三件、备份全量、版本治理。

### 部署与分发

- **两条一键命令**：`install.sh`（Ubuntu 容器：nginx + manager + 主脑脊柱）/ `install.ps1`（Windows 裸机），幂等跳过已装组件，唯一人肉输入 = API key
- `install.ps1` 带 UTF-8 BOM（发布前实测：无 BOM 时 Windows PowerShell 5.1 按 GBK 读中文 → ParserError，官方推荐路径直接失败）
- `install.ps1` 克隆失败自动回退 codeload zip（发布前实测：国内网络 github.com git/raw 均超时，codeload 可达 200）
- Windows 安装的节点依赖固定 `npx pnpm@9`（发布前实测：全局 pnpm 11 无视构建白名单，原生依赖不构建）；setup 预生成首启密码进 `.env`（隐藏窗口启动下生成密码会丢）
- **容器化**：dsh-node / manager 双镜像（构建期冻结依赖，运行时零安装）+ compose 脊柱 + manager 经 docker.sock 管理工蜂容器（标签对账，向导/起停/日志语义不变）
- nginx 三模式 TLS 模板 + `gen-env.sh` 幂等密钥生成 + 发布包生成器 + 发布清单（维护者内部）

### 安全（D2/D4）

- **首登强制改密**（既有账号也转正一次）+ 改密页；新密码 ≥ 10 字符
- **CSRF 双提交**：所有非 GET `/api/*` 校验（登录与主脑内部 API 豁免）
- **CSRF 自愈**：升级前的老会话缺 csrf cookie 时，服务端 403 补发 + 前端带新 cookie 自动重试一次（Windows 升级改密的 403 现场修复）
- **审计流水**：登录成败 / 改密 / 节点操作 / 备份，侧栏审计页
- `.env` 在 POSIX 上收紧 600

### 备份（D3）

- 节点 home（会话/技能/settings）**加密归档**（AES-256-CBC，密钥派生自 SESSION_SECRET）
- restore 扩展：DB + 节点 home 一并回滚
- DR 演练 `npm run drill`（CI 常驻，实测全链路 0.2s，RTO 目标 ≤ 5 分钟）

### 版本治理（R4）

- `COMPAT_DSH_VERSION` 单点真相源；setup 自检表（node/pnpm/git/dsh 红绿 + 端口占用检查，失败即红字退出，**无半成功态**）
- 节点 hostVersion 告警（/nodes 页黄标 + 日志）；profile bundle 钉版本；gateway 钉 commit
- Linux `detectDshBin` 修复（POSIX `command -v` + `npm root -g`）

### 工程

- docs/notes 拆分（公开 docs/ = 路线图 + 用户手册）、README 重写（零死链 CI 断言、测试数禁手写）
- CI：test + drill + fresh-boot 旅程 E2E + typecheck + audit + build + check-docs
- 测试套件 335 → 360+

## 1.0.0 — 蜂群 v1（2026-09-05）

单主机多节点版正式发布：默认安装 = manager（总办）+ 主脑（总控）+ 个人（工作区），
一条命令、5 分钟用起来。

### 蜂群核心

- **主脑**：全局协调入口（派工单 / 查 fleet / 起草定时任务），对工作区只读、执行永远委托；
  内部 REST API（仅 127.0.0.1 + `X-Brain-Token`）+ 技能手册（skill + curl，无 MCP）
- **delegation 帧**：主脑会话页可见派工轨迹，点击跳回被派会话；`brain_done` 站内通知
- **会话复用**：同类任务续接同名会话、空会话优先复用（`POST /api/internal/chats/:id/prompt`）
- **主脑日预算熔断**：`brain.daily_budget_usd`（默认 $1/天），只拦派工、人工不拦，409 人话转述

### 多节点（fleet）

- manager 拉起/停止/重启多个 DSH 节点（监督器五态 + 指数退避 + 连续失败停用）
- `/nodes` 页：节点全表 + 起/停/重启 + 日志抽屉；侧栏 `N/N` 就绪计数
- **新增节点向导**：节点 = 工作区成对创建（高级设置折叠自定义），端口自动分配，
  文件先行 + 失败自动回滚；删除 = 解除托管（磁盘目录保留）
- 每节点独立 DSH_HOME / 端口 / gateway 密钥（`GW_KEY_*` 进 `.env`）

### 会话与并发

- 多轮对话（会话 adopt / SSE 中继 / 取消 / 双计费防护）、会话归档与恢复、
  空会话自动清理（vacate）
- **同 agent 多会话并发**：会话内串行、会话间并行（DSH 原生语义 + git 提交锁 +
  冲突显性化 `run.conflict`）
- 首页直达最近会话；归档单跳不双刷新

### 平台化小件（P5）

- `/skills` 技能清单页（文件即真相 + 工作区 git HEAD 版本对照）+ 技能仓库约定位置
- 站内通知（铃铛 + 未读角标）：cron 成败 / 预算熔断 / 主脑派工完成
- 计价：峰谷窗口 + **周六周日全天谷价**（`pricing.weekends_off_peak`）

### 运维（P6）

- 数据库备份/恢复：15 分钟自动快照、保留策略（24h 全留 → 每日 30 天 → 每周 12 周）、
  `npm run backup/restore`
- 服务化：`npm run service -- install/uninstall/status`（Windows 任务计划 / systemd user unit）
- 自更新：`npm run update`（备份 → 拉新 → 构建 → 探活，失败自动回滚）
- E2E 冒烟：`node scripts/smoke.mjs`（登录 → 聊天回合 → 主脑派工 → 通知，全链路）

### 工程

- SQLite 显式迁移 `schema_version`；测试套件全绿（数量由 CI 断言）；前端零构建（hash 版本化资产）
- 文档体系：公开 `docs/`（用户手册 + 路线图）与内部 `notes/`（设计/计划/调研）分层
