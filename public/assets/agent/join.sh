#!/usr/bin/env bash
# 能力四（舰队 M1-5）：Linux 工作机一键加入——安装 node-agent（systemd user unit）。
# 用法：
#   MANAGER_URL=https://app.example.com AGENT_JOIN_TOKEN=dac-join-xxx bash join.sh
# 幂等：重跑不重复注册（agent 本地已存身份）；只动 ~/.dac-agent 与 user unit。
set -euo pipefail

MANAGER_URL="${MANAGER_URL:?需要 MANAGER_URL（manager 基址，如 https://app.example.com）}"
AGENT_JOIN_TOKEN="${AGENT_JOIN_TOKEN:?需要 AGENT_JOIN_TOKEN（manager 机器页签发的一次性 token）}"
AGENT_DIR="${AGENT_DIR:-$HOME/.dac-agent}"
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

mkdir -p "$AGENT_DIR"
# agent 包随 manager 发布物分发（静态面下载，无密钥内容）
curl -fsSL "$MANAGER_URL/assets/agent/runtime.mjs" -o "$AGENT_DIR/runtime.mjs"
curl -fsSL "$MANAGER_URL/assets/agent/agent.mjs" -o "$AGENT_DIR/agent.mjs"
curl -fsSL "$MANAGER_URL/assets/agent/update.mjs" -o "$AGENT_DIR/update.mjs"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/dac-agent.service" <<EOF
[Unit]
Description=DAC node-agent（能力四舰队）
After=network-online.target

[Service]
Type=simple
Environment=MANAGER_URL=$MANAGER_URL
Environment=AGENT_JOIN_TOKEN=$AGENT_JOIN_TOKEN
Environment=AGENT_DIR=$AGENT_DIR
WorkingDirectory=$AGENT_DIR
ExecStart=$NODE_BIN agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now dac-agent
sleep 2
systemctl --user --no-pager status dac-agent --lines=8 || true
echo "join.sh: agent 已安装并启动（AGENT_DIR=$AGENT_DIR）。manager 机器页应出现本机。"
