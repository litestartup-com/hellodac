#!/usr/bin/env bash
# Hive plan 2 P2/P5: generate/complete .env (idempotent: an existing non-empty value is never overwritten).
# Usage: bash scripts/gen-env.sh [env file]; DEEPSEEK_API_KEY can be pre-set by exporting it.
set -euo pipefail

ENV_FILE="${1:-.env}"
gen() { openssl rand -hex 32; }

ensure() { # key value
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null || [ -z "$(grep "^${key}=" "$ENV_FILE" | cut -d= -f2-)" ]; then
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

[ -f "$ENV_FILE" ] || : > "$ENV_FILE"

ensure SESSION_SECRET "$(gen)"
# Debt H1: the manager/node containers run as HOST_UID:HOST_GID (the compose user: directive).
# When it is not written, compose falls back to 1000:1000, which does not match the deploying user
# on this machine (e.g. 1001 for a GH runner) → the data/workspaces bind mount goes read-only →
# the manager crashes at boot (SQLITE_CANTOPEN).
# install.sh has the same two lines; the direct gen-env use cases (CI compose-e2e / manual bootstrap) must write them too.
ensure HOST_UID "$(id -u)"
ensure HOST_GID "$(id -g)"
ensure GW_KEY_A "apigw-$(openssl rand -hex 24)"
ensure GW_KEY_B "apigw-$(openssl rand -hex 24)"
ensure BRAIN_TOKEN "$(openssl rand -hex 24)"
ensure MANAGER_USERNAME "admin"
# Respect the password passed in by install.sh/the environment; generate randomly only when none was given
ensure MANAGER_INITIAL_PASSWORD "${MANAGER_PASSWORD:-$(openssl rand -hex 8)}"
ensure DSH_NODE_IMAGE "hellodac/dac-node:0.1.5-rc.2"
# Debt D5: the single source of truth for the version number = package.json (same source as inject-version in build)
ensure MANAGER_VERSION "$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
# Debt H1: the manager container can reach docker.sock only by joining the host docker group via group_add.
# When it cannot be probed (no docker installed locally) it falls back to 0 -- compose start then fails
# loudly on permissions.
DOCKER_GID_DETECTED="$(getent group docker | cut -d: -f3 2>/dev/null || true)"
ensure DOCKER_GID "${DOCKER_GID_DETECTED:-0}"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  ensure DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"
fi

chmod 600 "$ENV_FILE"
mkdir -p workspaces/personal workspaces/brain data

echo "[gen-env] $ENV_FILE ready (idempotent)."
echo "[gen-env] initial password: $(grep '^MANAGER_INITIAL_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
if ! grep -q '^DEEPSEEK_API_KEY=' "$ENV_FILE"; then
  echo "[gen-env] ⚠ DEEPSEEK_API_KEY is not set yet -- edit $ENV_FILE by hand, fill it in, then start."
fi
