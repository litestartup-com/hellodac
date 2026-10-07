#!/usr/bin/env bash
# Capability four (Fleet M1-5): one-command join for a Linux work machine -- installs the node-agent (systemd system unit).
#   MANAGER_URL=https://app.example.com AGENT_JOIN_TOKEN=dac-join-xxx bash join.sh
# Usage:
#   MANAGER_URL=... AGENT_JOIN_TOKEN=... AGENT_USER=dac bash join.sh   # dedicated non-root user (recommended)
#   MANAGER_URL=https://app.example.com AGENT_JOIN_TOKEN=dac-join-xxx bash join.sh
# Idempotent: re-running does not register twice (the agent already stored its identity locally); it only touches $AGENT_DIR and the systemd unit.
#
# AGENT_USER (added 2026-09-27, the precondition for isolating a public-facing agent):
#   the agent launches node processes as **its own OS user**, so dropping privileges means nothing more
#   than running the agent itself unprivileged -- every node it launches is then non-root by construction.
#   A public-facing agent must run this way: DSH does not isolate file reads, so a root public-facing
#   agent can read everything else on the machine (the database in the container, root's credentials).
#   Leaving the variable unset = the historical behavior (runs as root, fine for internal-only machines).
#
# Incident regression (2026-09-25 ubuntu-focal went missing): the old version installed a systemd **user** unit
# and only ran `systemctl --user enable --now` without enabling linger. A user manager exists only while a login
# session does -> after a host reboot the agent never came up at all and every node died; on top of that each SSH
# login created another root user manager, so several agents coexisted and fought over the same port (EADDRINUSE).
# Now it installs a system-level unit: no dependency on a login session, always starts at boot, no more duplicate instances.
set -euo pipefail

MANAGER_URL="${MANAGER_URL:?MANAGER_URL is required (the manager base URL, e.g. https://app.example.com)}"
AGENT_JOIN_TOKEN="${AGENT_JOIN_TOKEN:?AGENT_JOIN_TOKEN is required (a one-time token issued by the manager machines page)}"
AGENT_USER="${AGENT_USER:-}"
UNIT_NAME="dac-agent"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME.service"
# A system unit has to be written to /etc/systemd/system, and installing Node (below) also needs root --
# say so plainly when not root, never pretend it installed.
if [ "$(id -u)" -ne 0 ]; then
  echo "join.sh: root is required (installing a systemd system unit and possibly Node). Re-run with sudo." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "join.sh: systemd is required (the agent is installed as a systemd system unit) -- this host does not look like a systemd Linux." >&2
  exit 1
fi

# --- Node >= 22.19: detect, install or upgrade -----------------------------
# The floor is a real check, not a "node exists" check: the DSH 0.1.5 launcher depends on
# import.meta.main (below 22.17 it exits 0 silently -- the node dies the moment it is launched and
# the log stays empty), and the 0.2.x dsh family declares engines node >=22.19.0 (registry manifest,
# verified in the profile locks). When node is missing or below the floor, this installs Node
# $NODE_VERSION (the official tarball, into /usr/local) so the one-command join really is one command.
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=19
NODE_VERSION="${NODE_VERSION:-22.19.0}"
node_new_enough() {
  local bin="${1:-node}" maj min
  maj="$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  min="$("$bin" -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
  [ "$maj" -gt "$NODE_MIN_MAJOR" ] || { [ "$maj" -eq "$NODE_MIN_MAJOR" ] && [ "$min" -ge "$NODE_MIN_MINOR" ]; }
}

NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ] && node_new_enough "$NODE_BIN"; then
  echo "join.sh: node $(node -v) satisfies the >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} floor"
else
  if [ -n "$NODE_BIN" ]; then
    echo "join.sh: node $(node -v 2>/dev/null || echo unknown) is below the floor (>= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}) -- installing Node $NODE_VERSION into /usr/local"
  else
    echo "join.sh: node is not on PATH -- installing Node $NODE_VERSION into /usr/local"
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "join.sh: curl or wget is required to download Node -- install one, then re-run." >&2
    exit 1
  fi
  case "$(uname -m)" in
    x86_64)         NODE_ARCH=x64 ;;
    aarch64|arm64)  NODE_ARCH=arm64 ;;
    *) echo "join.sh: unsupported architecture '$(uname -m)' -- install Node >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} manually, then re-run." >&2; exit 1 ;;
  esac
  if ldd --version 2>&1 | grep -qi musl; then
    echo "join.sh: musl libc (e.g. Alpine) is not supported by the automatic install -- install Node >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} manually, then re-run." >&2
    exit 1
  fi
  TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  NODE_TMP="$(mktemp -d)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" -o "$NODE_TMP/$TARBALL"
  else
    wget -q "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" -O "$NODE_TMP/$TARBALL"
  fi
  tar -xJf "$NODE_TMP/$TARBALL" -C "$NODE_TMP"
  cp -a "$NODE_TMP/node-v${NODE_VERSION}-linux-${NODE_ARCH}/." /usr/local/
  rm -rf "$NODE_TMP"
  # Prefer the fresh install deterministically (an older apt node earlier on PATH must not win).
  NODE_BIN="/usr/local/bin/node"
  if [ ! -x "$NODE_BIN" ] || ! node_new_enough "$NODE_BIN"; then
    echo "join.sh: the Node install did not produce a usable binary -- check $NODE_BIN, then re-run." >&2
    exit 1
  fi
  echo "join.sh: installed Node $(node -v) at $NODE_BIN"
fi

# Privilege drop (when AGENT_USER is set): create the user, settle its home directory, hand the agent directory to it.
# The node directories and DSH_HOME both live under $AGENT_DIR, so dropping privileges here applies once and holds for the whole machine.
UNIT_USER_LINES=""
RUN_AS_USER=""
if [ -n "$AGENT_USER" ]; then
  if ! id -u "$AGENT_USER" >/dev/null 2>&1; then
    # --system: does not consume a regular user uid; the home directory is created because DSH/npm need a writable HOME.
    useradd --system --create-home --shell /bin/bash "$AGENT_USER"
    echo "join.sh: created the dedicated user $AGENT_USER"
  fi
  USER_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
  if [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then
    echo "join.sh: user $AGENT_USER has no usable home directory (getent returned '$USER_HOME') -- cannot place the agent directory." >&2
    exit 1
  fi
  # With no explicit AGENT_DIR, fall back to that user's home directory (root's $HOME does not apply).
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
# The agent package ships with the manager release (downloaded from the static surface, no secret content)
curl -fsSL "$MANAGER_URL/assets/agent/runtime.mjs" -o "$AGENT_DIR/runtime.mjs"
curl -fsSL "$MANAGER_URL/assets/agent/agent.mjs" -o "$AGENT_DIR/agent.mjs"
curl -fsSL "$MANAGER_URL/assets/agent/update.mjs" -o "$AGENT_DIR/update.mjs"
if [ -n "$RUN_AS_USER" ]; then
  chown -R "$RUN_AS_USER" "$AGENT_DIR"
fi

# Migration: remove the old user unit, otherwise an SSH login starts a second agent fighting for the same ports.
for legacy in "$UNIT_NAME" "ohdsh-agent"; do
  if systemctl --user list-unit-files "${legacy}.service" >/dev/null 2>&1; then
    systemctl --user disable --now "${legacy}.service" >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/${legacy}.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    echo "join.sh: removed the old user unit ${legacy}.service (so it cannot be started twice alongside the system unit)"
  fi
done
# Migration: the same leftover at the SYSTEM level (33.11 ran an ohdsh-agent system unit before the
# rename); the user-unit loop above cannot see it. Remove it so it cannot start a second agent next to ours.
for legacy in "ohdsh-agent"; do
  if [ -f "/etc/systemd/system/${legacy}.service" ]; then
    systemctl disable --now "${legacy}.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${legacy}.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
    echo "join.sh: removed the old system unit ${legacy}.service (so it cannot fight the new one for the port)"
  fi
done

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=DAC node-agent (capability four fleet)
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
# What launches the DSH nodes is a child process of the agent; when the agent exits for a self-update restart it replaces only itself,
# so it must not take the nodes that are busy working with it (KillMode=process = do not kill the rest of the cgroup).
KillMode=process

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
sleep 2
systemctl --no-pager status "$UNIT_NAME" --lines=8 || true
if [ -n "$RUN_AS_USER" ]; then
  echo "join.sh: the agent is installed as the system service ${UNIT_NAME}.service (AGENT_DIR=$AGENT_DIR, running as user $RUN_AS_USER), started at boot. The machine should now appear on the manager's machines page."
  echo "join.sh: the privilege drop is in effect -- every node it launches runs as $RUN_AS_USER and cannot read files owned by root (container data, root credentials)."
else
  echo "join.sh: the agent is installed as the system service ${UNIT_NAME}.service (AGENT_DIR=$AGENT_DIR), started at boot. The machine should now appear on the manager's machines page."
  echo "join.sh: note -- this run was as root: fine for internal-only machines; to run a public-facing agent, re-install with AGENT_USER=<dedicated user>."
fi
