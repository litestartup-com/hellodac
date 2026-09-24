#!/usr/bin/env bash
# 蜂群2计划 P2/P5：生成/补全 .env（幂等：已有且非空的值绝不覆盖）。
# 用法：bash scripts/gen-env.sh [env文件]；DEEPSEEK_API_KEY 可先 export 预置。
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
# 债务 H1：manager/node 容器以 HOST_UID:HOST_GID 运行（compose user: 指令）。
# 不写入时 compose 回落 1000:1000，与本机部署用户（如 GH runner 的 1001）
# 不一致 → data/workspaces bind mount 只读 → manager 启动即崩（SQLITE_CANTOPEN）。
# install.sh 有同款两行，gen-env 直接用的场景（CI compose-e2e / 手动引导）也必须写。
ensure HOST_UID "$(id -u)"
ensure HOST_GID "$(id -g)"
ensure GW_KEY_A "apigw-$(openssl rand -hex 24)"
ensure GW_KEY_B "apigw-$(openssl rand -hex 24)"
ensure BRAIN_TOKEN "$(openssl rand -hex 24)"
ensure MANAGER_USERNAME "admin"
# 尊重 install.sh/环境传入的口令；未提供才随机生成
ensure MANAGER_INITIAL_PASSWORD "${MANAGER_PASSWORD:-$(openssl rand -hex 8)}"
ensure DSH_NODE_IMAGE "hellodac/dac-node:0.1.2-rc.1"
# 债务 D5:版本号唯一真相源 = package.json(与 build 的 inject-version 同源)
ensure MANAGER_VERSION "$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
# 债务 H1：manager 容器经 group_add 加入宿主 docker 组才能访问 docker.sock。
# 探测不到（本机未装 docker）落 0——compose 启动会因权限失败而显性报错。
DOCKER_GID_DETECTED="$(getent group docker | cut -d: -f3 2>/dev/null || true)"
ensure DOCKER_GID "${DOCKER_GID_DETECTED:-0}"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  ensure DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"
fi

chmod 600 "$ENV_FILE"
mkdir -p workspaces/personal workspaces/brain data

echo "[gen-env] $ENV_FILE 就绪（幂等）。"
echo "[gen-env] 初始密码：$(grep '^MANAGER_INITIAL_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
if ! grep -q '^DEEPSEEK_API_KEY=' "$ENV_FILE"; then
  echo "[gen-env] ⚠ 尚未设置 DEEPSEEK_API_KEY —— 手动编辑 $ENV_FILE 填入后启动。"
fi
