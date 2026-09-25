# DAC — Dispatched Agent Cluster

> **One Manager. A Fleet of Agents.**
> DAC 是 MIT 开源的多机 agent 控制面：跨服务器管理并暴露容器化 agent 节点舰队
> （当前基于 DeepSeek Harness），提供统一对话与 API 访问。
> 默认安装 = manager（总办）+ 主脑（总控）+ 个人（工作区）。一条命令、5 分钟用起来。

> English version: [README.md](./README.md)。界面**默认英文，可一键切换中文**（语言切换在侧栏 ⋮ 菜单里）。

## 一键安装

**Linux 服务器（容器，推荐）：**

```bash
curl -fsSL https://raw.githubusercontent.com/litestartup-com/hellodac/v1.0.0/install.sh -o install.sh && bash install.sh
# 熟手一行：curl -fsSL https://raw.githubusercontent.com/litestartup-com/hellodac/v1.0.0/install.sh | bash
```

**Windows（本机直跑）：**

```powershell
irm https://raw.githubusercontent.com/litestartup-com/hellodac/v1.0.0/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
# 熟手一行：irm https://raw.githubusercontent.com/litestartup-com/hellodac/v1.0.0/install.ps1 | iex
```

脚本幂等：已装组件自动跳过，重跑不覆盖配置与数据；唯一需要输入的是 DeepSeek API key
（`DEEPSEEK_API_KEY=...` 预置则全自动）；首次登录强制修改密码。
完整使用手册见 `docs/USER-GUIDE.md`。

## 是什么

DeepSeek Harness 提供 agent 运行时（会话 / 工具 / 沙箱 / 文件系统）；DAC 提供控制面：
认证、聊天中继、主脑派工、节点与机器管理、技能清单、记账、备份恢复。

概念层级（详见 `docs/USER-GUIDE.md`）：

```
服务器 ──► 节点（= 一个 DSH agent 进程 + 独立 DSH_HOME）──► 工作区（身份+目录+preset+沙箱）──► 会话
```

- **主脑** = manager 级总控：跨域规划、派工单、查 fleet；对工作区只读，执行永远委托。
- **工作区** = 文件即真相的边界：每个工作区一个 git 仓，每次运行落一次提交（审计留痕）。

## 功能

- **聊天 UI**：多轮对话、流式输出、工具调用卡片、互动提问/授权卡片直接作答；支持端点会显示上下文使用率、会话模型选择及只读/工作区可写访问模式切换
- **主脑派工**：对话式编排 + delegation 帧（点击跳回被派会话）+ 会话复用（同类续接）
- **多节点**：`/nodes` 页全 UI 管控（起/停/重启/日志）+ 向导新增节点 + 侧栏 `N/N` 就绪计数；向导可选节点形态——**容器工蜂（隔离）**或**宿主机进程（整机能力，黄字风险 + 审计）**，宿主机节点依赖装进自己目录、不碰全局 npm
- **多会话并发**：会话内串行、会话间并行（DSH 原生语义 + git 提交锁 + 冲突显性化）
- **计划运行**：调度 API 驱动无人值守任务（起草默认停用；主脑派工受日预算熔断约束）
- **技能清单**：`/skills` 页按工作区列技能 + 版本对照（= 工作区 git HEAD）
- **站内通知**：铃铛——机器掉线 / 节点异常 / 预算熔断 / 主脑任务完成
- **记账**：峰谷计价（**周六周日全天谷价**）、每 run 花费、月度汇总、按工作区分账
- **备份恢复**：手动 `npm run backup` + 一键恢复；自动快照可选（`backup.auto: true` 开启，**默认关闭**——15 分钟 DB 快照 + 保留策略 24h 全留 → 每日 30 天 → 每周 12 周；间隔可用 `backup.interval_minutes` 调，如 1440 = 每日）
- **服务化**：开机自启（Windows 任务计划 / Linux systemd）
- **自更新**：备份 → 拉新 → 构建 → 探活，失败自动回滚
- **原生 GUI 一键直开**：节点页「原生 GUI」卡——一条 SSH 隧道命令（密钥只在你本机）+
  一键打开节点原生界面，0.1.5 的 token 由 manager 自动捕获拼接、重启轮换自动跟随
  （DSH 原生 UI 只绑 loopback，反代不可行——见设计库事实卡 dsh-facts §11）
- **节点级 DSH 版本**：(dsh ↔ facade) 版本矩阵为唯一真相源；建节点可钉版本，
  节点页显示配置版本 + 漂移状态，一键对齐（重建 profile → 重装依赖 → 重启）
- **舰队（多服务器）**：机器目录 + 一条 join 命令把新服务器接入（node-agent
  常驻服务、出站拨号、零入站端口）；向导选「主机」即可把节点建到远端宿主机
  进程形态；manager 掉线节点照跑、agent 保活自愈重连

## 打开节点原生 GUI（SSH 隧道）

1. 节点页点「配置原生访问」：填一次 SSH 账号 / 主机 / 端口与本地映射端口，
   可选填本机 SSH 私钥路径（命令会带上 `-i`）；
2. 终端执行卡片上的 `ssh -L` 命令（窗口保持打开）；
3. 点「打开 GUI」——新标签页直达该节点的 DSH 原生界面。

**本机节点免隧道**：节点地址是 loopback（127.0.0.1/localhost）时，卡片直接
切成「本机直连」——浏览器与节点同在 loopback，一键直达原生界面（URL 用节点
启动行里自己打印的端口，token 照拼）。

manager 只生成「怎么连」的命令，**SSH 私钥永不进入 manager**（只记录可选的本机
私钥*路径*）；隧道两端都绑 loopback，节点 GUI 端口也只发布在宿主机 127.0.0.1
（不进公网面）。

## 节点级 DSH 版本

节点向导可填 `dsh_version`，按版本矩阵 `SUPPORTED_DSH`（`src/dsh-matrix.ts`——
每行 = DSH 版本 ↔ facade ref 配对）校验：未知版本直接拒绝，未验证配对安装带
黄字警告。每个节点的 profile 钉自己的版本；节点页显示配置版本 + 漂移状态，
「对齐版本」= 重建 profile → 重装依赖 → 按钉版重启。容器节点用镜像
`hellodac/dac-node:<version>`。节点行另有版本下拉——切版本是页面操作（容器 =
换镜像重建；进程 = 重播种 + 重装 + 重启），不需要改配置文件。

## 机器与舰队（多服务器）

1. 节点页「机器」区点「**添加机器**」→ 拿到一条 join 命令（token 15 分钟
   有效、一次性）；
2. 在目标服务器上执行 join 命令（把 node-agent 装成 **system 服务**并注册
   现身；需要 root，生成的命令已用 `sudo bash` 提权，装完即开机自启）；
3. 向导「新增节点」时选「**主机**」下拉里的机器 + 填「节点地址」
   （manager 可达的 `http://IP:端口`）→ 节点即建到那台机器的宿主机进程形态
   （整机能力，黄字确认 + 审计）。

- 每台服务器 = 一个 node-agent（零配置：只有 MANAGER_URL 与 token 两个环境
  变量；**零入站端口**，出站拨号 manager）；
- **manager 掉线节点照跑**：agent 保活重连、恢复后对账收敛；
- 机器页可**吊销**（token 立即失效）或**轮换密钥**（仅在线机器；新 token 经
  指令通道投递，旧 token 30 分钟宽限防打砖）；
- **可观测性**：机器行实时显示 CPU/内存/磁盘占用（agent 60s 心跳采样，
  manager 保留 7 天趋势，`GET /api/agents/:id/metrics` 可取序列）；agent
  掉线/节点异常自动进站内铃铛；版本落后显示「待更新」徽标并可一键下发自更新；
- 安全：agent 是固定指令集（非通用 shell）；节点 facade 端口要防火墙白名单
  （只放行 manager 出口 IP）；GUI 仍走用户侧 SSH 隧道。

### 运维助手节点（ops）

关键服务器（生产/线上/manager 宿主）建议在装 agent 之外再加一个 **ops
运维助手节点**（设计库布放规则 D3）：向导选主机 + 地址后，沙箱模式选
**danger-full-access（整机全量 · 高危）**：

- 该档位授予整机全量能力（文件/终端/系统操作），危险操作必须经
  **审批卡片**人工放行（facade 侧，Q2 拍板口径）；创建与开锁均留审计；
- **服务器运维账号凭据留在节点所在机器**，不经 manager 下发；
- 节点侧需开锁全量沙箱（`host.describe` 的 allowFullAccess 由 facade 决定），
  未开锁时聊天里的「全量访问」档会显示锁定。

### 规模与背压边界（M4-2）

- **通道限流**：join 签发 20/分、agent 注册 10/分、指令长轮询 240/分、
  事件回报 240/分、吊销/轮换 20/分；长轮询单次等待 ≤25 秒、事件批 ≤100 条、
  日志分块 ≤32KB——所有限流都是每 agent/每用户独立计数。
- **日志限额**：manager 侧 agent 日志环形缓冲 64KB/节点（内存）；agent 侧
  `node.log` 上限 50MB，spawn 前超限自动轮转（保留一代 `.1` 供崩溃排障）。
- **单 manager 规模建议 ≤50 台**：每台 = 1 条长轮询连接（心跳 ~30s），
  N 台 ≈ N/30s 的轮询请求 + 事件 POST，SQLite 单写者与指令队列（按 agent
  索引）在 50 台内是舒适区；更多机器走多 manager 分片（规划中）。

### facade 防火墙白名单（跨公网前必须收紧）

agent 节点的 facade 端口（如 3081）暴露在服务器上，**必须只放行 manager
的出口 IP**；GUI 走用户侧 SSH 隧道（loopback），不受影响。manager 出口 IP
= manager 所在服务器访问外网的源 IP（云上多为 EIP/公网 IP）。

- **Linux（ufw）**：
  `sudo ufw allow from <manager出口IP> to any port 3081 proto tcp && sudo ufw enable`
- **Linux（firewalld）**：
  `sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<manager出口IP>" port port="3081" protocol="tcp" accept' && sudo firewall-cmd --reload`
- **云安全组**：入方向仅允许 `<manager出口IP>/32` → 节点端口，其余拒绝。
- **验收**：从非白名单 IP `curl` facade → 拒绝；manager 侧探活正常
  （`/nodes` 页节点仍 live）。



## 升级

- **裸机**：`npm run update`——备份 → 拉新 → 构建 → 探活，失败自动回滚
- **容器（compose）**：`.env` 里把 `MANAGER_VERSION` 改成新 tag → `docker compose up -d`
- **节点 DSH 版本**：`/nodes` 节点行下拉直接切换
- **配置迁移全自动**：旧 `manager.config.yaml` 在启动时自动升级（原文件备份为
  `.pre-mig.bak`），升级不需要手改配置

## 从源码运行（开发者）

前置：Node ≥ 20（推荐 22）、git、DeepSeek Harness（版本见 `COMPAT_DSH_VERSION`）；
节点依赖由 setup 用 npm 安装，无需全局 pnpm。

```powershell
git clone <repo-url>
cd hellodac
npm install
npm run setup          # 自检表（node/git/dsh）+ 初始化工作区/节点/配置
npm run build
npm start              # 启动 manager，自动拉起托管节点
```

## CLI 一览

| 命令 | 用途 |
| --- | --- |
| `npm run setup [--force]` | 初始化/重装（`--force` 保留已定制的工作区） |
| `npm start` | 启动 manager（自动拉起托管节点） |
| `npm run nodes -- up/down/list/logs <名>` | 节点生命周期（UI 在 /nodes 页） |
| `npm run backup [-- list]` / `npm run restore -- latest` | 备份 / 恢复（恢复前自动探测 manager 是否在跑） |
| `npm run service -- install/uninstall/status` | 开机自启服务 |
| `npm run update` | 自更新（失败自动回滚） |
| `npm test` / `npm run typecheck` | 测试 / 类型检查 |

## 配置

`manager.config.yaml` 是唯一真相源：`endpoints`（每个 DSH 进程的入口 + spawn 生命周期）、
`agents`（工作区绑定）、`runner`（超时/静默/预算）、`pricing`（峰谷窗口 + 周末规则）、
`brain.daily_budget_usd`（主脑派工熔断）。密钥只进 `.env`（`GW_KEY_*` / `BRAIN_TOKEN`），永不入库。

## 文档

| 文档 | 内容 |
| --- | --- |
| `docs/USER-GUIDE.md` | 用户手册（安装 / 主脑 / 节点 / 定时 / 记账 / 备份） |
| `README.md` | 本 README 的英文版 |
| `CHANGELOG.md` | 变更记录 |

> **本仓库只放用户面文档。** 设计稿、路线图、实施计划、评审记录、发布流程、
> 上游行为事实卡均在不公开的内部设计库。**已交付的能力看 `CHANGELOG.md` 与
> GitHub Release，不对未发布的功能做公开承诺。** 代码、配置样例与用户手册
> 即完整的可运行、可自托管交付物。

## 测试

```powershell
npm test   # 全绿（数量由 CI 断言，不手写）
```

## License

MIT
