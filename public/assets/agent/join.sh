#!/usr/bin/env bash
# 能力四（舰队 M1-5）：Linux 工作机一键加入——安装 node-agent（systemd system unit）。
# 用法：
#   MANAGER_URL=https://app.example.com AGENT_JOIN_TOKEN=dac-join-xxx bash join.sh
#   MANAGER_URL=... AGENT_JOIN_TOKEN=... AGENT_USER=dac bash join.sh   # 专用非 root 用户（推荐）
# 幂等：重跑不重复注册（agent 本地已存身份）；只动 $AGENT_DIR 与 systemd unit。
#
# AGENT_USER（2026-09-27 加入，对外 agent 的隔离前提）：
#   agent 以**自己的 OS 用户**拉起节点进程，所以"降权"只要让 agent 本身降权即可——
#   它拉起的每个节点天然都是非 root。对外 agent 必须这样跑：DSH 读文件不隔离，
#   root 的对外 agent 能读到同机其它东西（容器里的数据库、root 的凭据）。
#   不设该变量 = 与历史行为一致（root 跑，适合纯对内机器）。
#
# 事故回归（2026-09-25 ubuntu-focal 失联）：旧版装的是 systemd **user** unit，
# 只 `systemctl --user enable --now`，没开 linger。user manager 默认只在有登录
# 会话时存在 → 主机重启后 agent 根本没起来，节点全灭；而且每次 SSH 登录都会新建
# 一个 root user manager，多个 agent 并存抢同一端口（EADDRINUSE）。
# 现在改为 system 级 unit：不依赖登录会话、开机必起、不会再有多实例。
set -euo pipefail

MANAGER_URL="${MANAGER_URL:?需要 MANAGER_URL（manager 基址，如 https://app.example.com）}"
AGENT_JOIN_TOKEN="${AGENT_JOIN_TOKEN:?需要 AGENT_JOIN_TOKEN（manager 机器页签发的一次性 token）}"
AGENT_USER="${AGENT_USER:-}"
UNIT_NAME="dac-agent"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME.service"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "join.sh: 需要 Node ≥22.18（node 不在 PATH）——先安装 node 再重跑。" >&2
  exit 1
fi
# M2 实测：DSH 0.1.5 启动器依赖 import.meta.main（Node ≥22.18），22.17 上
# 启动器静默退出 0（节点拉起来即死、日志空）——版本门禁必须真实校验。
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  echo "join.sh: 需要 Node ≥22.18（DSH 0.1.5 启动器依赖 import.meta.main）——当前 $(node -v 2>/dev/null || echo 无)" >&2
  exit 1
fi

# system unit 要写 /etc/systemd/system —— 非 root 直接说清楚，别装作装好了。
if [ "$(id -u)" -ne 0 ]; then
  echo "join.sh: 需要 root（安装 systemd system unit 到 $UNIT_PATH）。请用 sudo 重跑。" >&2
  exit 1
fi

# 降权（AGENT_USER 设置时）：建用户、定家目录、把 agent 目录交给它。
# 节点目录与 DSH_HOME 都在 $AGENT_DIR 下，所以降权是"一处生效、全机生效"。
UNIT_USER_LINES=""
RUN_AS_USER=""
if [ -n "$AGENT_USER" ]; then
  if ! id -u "$AGENT_USER" >/dev/null 2>&1; then
    # --system：不占普通用户 uid 段；给了家目录（DSH/npm 需要 HOME 可写）。
    useradd --system --create-home --shell /bin/bash "$AGENT_USER"
    echo "join.sh: 已创建专用用户 $AGENT_USER"
  fi
  USER_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
  if [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then
    echo "join.sh: 用户 $AGENT_USER 没有可用家目录（getent 返回 '$USER_HOME'）——无法安置 agent 目录。" >&2
    exit 1
  fi
  # 未显式给 AGENT_DIR 时，落到该用户家目录下（root 的 $HOME 不适用）。
  if [ -z "${AGENT_DIR:-}" ]; then
    AGENT_DIR="$USER_HOME/.dac-agent"
  fi
  UNIT_USER_LINES="User=$AGENT_USER
Group=$(id -gn "$AGENT_USER")
Environment=HOME=$USER_HOME"
  RUN_AS_USER="$AGENT_USER"
fi

AGENT_DIR="${AGENT_DIR:-$HOME/.dac-agent}"

mkdir -p "$AGENT_DIR"
# agent 包随 manager 发布物分发（静态面下载，无密钥内容）
curl -fsSL "$MANAGER_URL/assets/agent/runtime.mjs" -o "$AGENT_DIR/runtime.mjs"
curl -fsSL "$MANAGER_URL/assets/agent/agent.mjs" -o "$AGENT_DIR/agent.mjs"
curl -fsSL "$MANAGER_URL/assets/agent/update.mjs" -o "$AGENT_DIR/update.mjs"
if [ -n "$RUN_AS_USER" ]; then
  chown -R "$RUN_AS_USER" "$AGENT_DIR"
fi

# 迁移：清掉旧版 user unit，否则 SSH 登录会再拉起一个 agent 抢同一批端口。
for legacy in "$UNIT_NAME" "ohdsh-agent"; do
  if systemctl --user list-unit-files "${legacy}.service" >/dev/null 2>&1; then
    systemctl --user disable --now "${legacy}.service" >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/${legacy}.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    echo "join.sh: 已移除旧 user unit ${legacy}.service（避免与 system unit 重复拉起）"
  fi
done

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=DAC node-agent（能力四舰队）
Documentation=$MANAGER_URL
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$UNIT_USER_LINES
Environment=MANAGER_URL=$MANAGER_URL
Environment=AGENT_JOIN_TOKEN=$AGENT_JOIN_TOKEN
Environment=AGENT_DIR=$AGENT_DIR
WorkingDirectory=$AGENT_DIR
ExecStart=$NODE_BIN agent.mjs
Restart=always
RestartSec=5
# 拉起 DSH 节点的是 agent 的子进程；agent 自更新退出重启时只换自己，
# 别把正在干活的节点一起带走（KillMode=process = 不杀 cgroup 其余进程）。
KillMode=process

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
sleep 2
systemctl --no-pager status "$UNIT_NAME" --lines=8 || true
if [ -n "$RUN_AS_USER" ]; then
  echo "join.sh: agent 已安装为 system 服务 ${UNIT_NAME}.service（AGENT_DIR=$AGENT_DIR，以用户 $RUN_AS_USER 运行），开机自启。manager 机器页应出现本机。"
  echo "join.sh: 降权生效——它拉起的每个节点都是 $RUN_AS_USER，读不到 root 拥有的文件（容器数据、root 凭据）。"
else
  echo "join.sh: agent 已安装为 system 服务 ${UNIT_NAME}.service（AGENT_DIR=$AGENT_DIR），开机自启。manager 机器页应出现本机。"
  echo "join.sh: 注意——本次以 root 运行：适合纯对内机器；要跑对外 agent 请带 AGENT_USER=<专用用户> 重装。"
fi
