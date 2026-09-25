#!/usr/bin/env bash
# 能力四（舰队 M1-5）：Linux 工作机一键加入——安装 node-agent（systemd system unit）。
# 用法：
#   MANAGER_URL=https://app.example.com AGENT_JOIN_TOKEN=dac-join-xxx bash join.sh
# 幂等：重跑不重复注册（agent 本地已存身份）；只动 $AGENT_DIR 与 systemd unit。
#
# 事故回归（2026-09-25 ubuntu-focal 失联）：旧版装的是 systemd **user** unit，
# 只 `systemctl --user enable --now`，没开 linger。user manager 默认只在有登录
# 会话时存在 → 主机重启后 agent 根本没起来，节点全灭；而且每次 SSH 登录都会新建
# 一个 root user manager，多个 agent 并存抢同一端口（EADDRINUSE）。
# 现在改为 system 级 unit：不依赖登录会话、开机必起、不会再有多实例。
set -euo pipefail

MANAGER_URL="${MANAGER_URL:?需要 MANAGER_URL（manager 基址，如 https://app.example.com）}"
AGENT_JOIN_TOKEN="${AGENT_JOIN_TOKEN:?需要 AGENT_JOIN_TOKEN（manager 机器页签发的一次性 token）}"
AGENT_DIR="${AGENT_DIR:-$HOME/.dac-agent}"
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

mkdir -p "$AGENT_DIR"
# agent 包随 manager 发布物分发（静态面下载，无密钥内容）
curl -fsSL "$MANAGER_URL/assets/agent/runtime.mjs" -o "$AGENT_DIR/runtime.mjs"
curl -fsSL "$MANAGER_URL/assets/agent/agent.mjs" -o "$AGENT_DIR/agent.mjs"
curl -fsSL "$MANAGER_URL/assets/agent/update.mjs" -o "$AGENT_DIR/update.mjs"

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
echo "join.sh: agent 已安装为 system 服务 ${UNIT_NAME}.service（AGENT_DIR=$AGENT_DIR），开机自启。manager 机器页应出现本机。"
