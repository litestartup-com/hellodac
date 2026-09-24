#!/usr/bin/env bash
# DAC — one-command install (Ubuntu 24, single-host container form:
# nginx + manager + 主脑 spine; the 个人 worker is created by the manager).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/litestartup-com/hellodac/v1.0.0/install.sh -o install.sh && bash install.sh
#   # one-liner for the impatient: curl -fsSL https://raw.githubusercontent.com/litestartup-com/hellodac/v1.0.0/install.sh | bash
#
# Idempotent: Docker present → skipped; .env existing → never overwritten.
# Non-interactive: DEEPSEEK_API_KEY / MANAGER_PASSWORD / MANAGER_PORT / APP_DOMAIN /
# TLS_MODE / DAC_VERSION can be preset via environment; only the missing ones prompt.
# Plan-only pass: DRY_RUN=1 bash install.sh
#
# Note: output is intentionally English — a minimal server locale (LANG=C)
# would garble non-ASCII text (the one sanctioned exception to 默认中文).
set -euo pipefail

# 安装目录 = 执行本脚本时所在的目录（cd 到哪装到哪；APP_DIR 环境变量可覆盖）。
APP_DIR="${APP_DIR:-.}"
DAC_VERSION="${DAC_VERSION:-v1.0.0}"
RELEASE_BASE="https://github.com/litestartup-com/hellodac/releases/download/${DAC_VERSION}"
MANAGER_PORT="${MANAGER_PORT:-8080}"
DRY_RUN="${DRY_RUN:-0}"
YES="${YES:-0}"
APP_DOMAIN="${APP_DOMAIN:-}"
TLS_MODE="${TLS_MODE:-}"
SSL_CERT_PATH="${SSL_CERT_PATH:-/etc/ssl/dac/cert.pem}"
SSL_KEY_PATH="${SSL_KEY_PATH:-/etc/ssl/dac/key.pem}"
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
MANAGER_PASSWORD="${MANAGER_PASSWORD:-}"

log() { echo "[install] $*"; }
run() { if [ "$DRY_RUN" = "1" ]; then log "DRY: $*"; else "$@"; fi }

confirm() {
  [ "$YES" = "1" ] && return 0
  [ "$DRY_RUN" = "1" ] && return 0
  read -rp "$1 [y/N]: " ANS || true
  case "$ANS" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}

# ---- plan first (计划先行) ----
log "plan: Docker (skip if present) → download release ${DAC_VERSION} → .env (never overwrite) → compose up"
log "install dir: $(pwd)"
confirm "Continue?" || { log "aborted."; exit 0; }

# 家目录本身拒绝默认安装：避免把 docker-compose.yml/.env/workspaces 摊一屋子
if [ "$APP_DIR" = "." ] && [ "$(pwd)" = "$HOME" ]; then
  echo "[install] 检测到你在家目录（$HOME）里执行——请先建一个专用目录再跑："
  echo "           mkdir -p ~/appx && cd ~/appx && bash ~/install.sh"
  echo "          （确要装进家目录本身：设 APP_DIR=\$HOME 重跑。）"
  exit 1
fi

# ---- docker ----
if command -v docker >/dev/null 2>&1; then
  log "Docker present, skipping install."
else
  log "Docker not found."
  confirm "Install Docker via get.docker.com?" || { log "aborted (Docker required)."; exit 1; }
  run sh -c 'curl -fsSL https://get.docker.com | sh'
fi
if [ "$DRY_RUN" != "1" ]; then
  docker compose version >/dev/null 2>&1 || { echo "[install] docker compose (v2 plugin) not available."; exit 1; }
fi

# ---- release bundle ----
if ! command -v unzip >/dev/null 2>&1 && [ "$DRY_RUN" != "1" ]; then
  log "unzip not found."
  confirm "Install unzip (apt)?" || { log "aborted (unzip required)."; exit 1; }
  run apt-get update -qq
  run apt-get install -y unzip
fi
if ! command -v git >/dev/null 2>&1 && [ "$DRY_RUN" != "1" ]; then
  log "git not found."
  confirm "Install git (apt)?" || { log "aborted (git required for fallback)."; exit 1; }
  run apt-get update -qq
  run apt-get install -y git
fi
if [ -f "$APP_DIR/docker-compose.yml" ]; then
  log "skip (exists): $APP_DIR"
else
  log "Downloading release bundle ${DAC_VERSION}..."
  run mkdir -p "$APP_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY: curl ${RELEASE_BASE}/dac-compose.zip"
  elif curl -fsSL "${RELEASE_BASE}/dac-compose.zip" -o /tmp/dac-compose.zip 2>/dev/null; then
    unzip -q -o /tmp/dac-compose.zip -d "$APP_DIR"
    rm -f /tmp/dac-compose.zip
    log "bundle unpacked."
  else
    # 发布包尚不存在（tag 未打）或下载失败：回退到源码克隆。
    # 绝不 rm -rf 安装目录（APP_DIR=. 时会删掉用户当前目录本身）——克隆进临时目录再搬入。
    log "release bundle unavailable — falling back to git clone (master)"
    TMP_CLONE="$(mktemp -d)"
    run git clone --depth 1 https://github.com/litestartup-com/hellodac.git "$TMP_CLONE"
    run cp -a "$TMP_CLONE"/. "$APP_DIR"/
    run rm -rf "$TMP_CLONE"
  fi
fi

# ---- secrets (唯一人肉输入 = API key) ----
if [ -z "$DEEPSEEK_API_KEY" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    DEEPSEEK_API_KEY="(ask in real run)"
  else
    read -rp "DeepSeek API key (the only required input): " DEEPSEEK_API_KEY || true
  fi
fi
if [ -z "$MANAGER_PASSWORD" ] && [ "$DRY_RUN" != "1" ]; then
  read -rsp "Manager initial password (empty = generate one): " MANAGER_PASSWORD; echo
fi

# ---- domain / TLS（留空 = 纯 HTTP 直连；给了域名会自动问 TLS 模式）----
if [ -z "$APP_DOMAIN" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY: domain not provided — plain HTTP"
  else
    read -rp "Public domain (empty = plain HTTP, no TLS): " APP_DOMAIN || true
  fi
fi

# ---- .env + config (never overwrite) ----
cd "$APP_DIR"
APP_DIR_ABS="$(pwd)"
if [ "$DRY_RUN" = "1" ]; then
  log "DRY: scripts/gen-env.sh .env + host_volumes 宿主侧路径重钉到 ${APP_DIR_ABS}/workspaces"
else
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" MANAGER_PASSWORD="$MANAGER_PASSWORD" bash scripts/gen-env.sh .env
  # 评审 B2 + 搬家重钉（2026-09-20）：host_volumes 里行首的宿主侧工作区路径
  # （左=宿主机、右=节点容器内路径）每次运行都重钉到当前安装目录的真实绝对路径——
  # 目录移动后 cd 进去重跑 install.sh 即收敛（幂等，不匹配时无变化）。
  # 注意只匹配「行首绝对路径 + /workspaces 结尾」：冒号右侧的容器内路径与
  # agents.workspace 行不受影响（它们保持容器视角，不随宿主目录变）。
  if [ -f manager.config.yaml ]; then
    sed -i -E "s|^([[:space:]]*)/[^ :]+/workspaces|\1${APP_DIR_ABS}/workspaces|g" manager.config.yaml
    log "config exists: host workspace path re-pinned to ${APP_DIR_ABS}/workspaces"
  else
    cp manager.config.container.example.yaml manager.config.yaml
    sed -i -E "s|^([[:space:]]*)/[^ :]+/workspaces|\1${APP_DIR_ABS}/workspaces|g" manager.config.yaml
    log "created: manager.config.yaml (host workspace path pinned to ${APP_DIR_ABS}/workspaces)"
  fi
  # 节点容器与宿主机部署用户同 uid（工作区写权限两边一致；root 服务器 = 0）
  grep -q '^HOST_UID=' .env || echo "HOST_UID=$(id -u)" >> .env
  grep -q '^HOST_GID=' .env || echo "HOST_GID=$(id -g)" >> .env
  # 债务 H1：manager 容器以 HOST_UID:HOST_GID 运行——真相文件与数据目录
  # 必须按同一属主放行（root 部署 = 0:0 时 chown 无变化，manager 保持 root，
  # 降权只在非 root 部署用户下生效；docker.sock 的组级访问见 gen-env.sh 的 DOCKER_GID）
  HOST_UID_VAL="$(grep '^HOST_UID=' .env | cut -d= -f2)"
  HOST_GID_VAL="$(grep '^HOST_GID=' .env | cut -d= -f2)"
  mkdir -p data workspaces
  chown -R "$HOST_UID_VAL:$HOST_GID_VAL" .env manager.config.yaml data workspaces
fi

# ---- optional nginx TLS ----
if [ -n "$APP_DOMAIN" ]; then
  if [ -z "$TLS_MODE" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      TLS_MODE=origin-ca
    else
      read -rp "TLS mode — origin-ca (Cloudflare Origin CA, default) / letsencrypt / none (CF Flexible) [origin-ca]: " TLS_MODE || true
      [ -n "$TLS_MODE" ] || TLS_MODE=origin-ca
    fi
  fi
  log "nginx: domain=$APP_DOMAIN tls=$TLS_MODE"

  if [ "$TLS_MODE" = "origin-ca" ]; then
    # 证书约定位置 = <安装目录>/ssl/cert.pem 与 key.pem（文档明示，可提前放置）；
    # 也支持交互输入现有证书路径，或 SSL_CERT_SRC/SSL_KEY_SRC 环境变量指定。
    # 新用户从 Cloudflare 下载的证书（SSL/TLS → Origin Server）直接放进约定位置即可。
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY: ensure cert/key (canonical: $APP_DIR_ABS/ssl/{cert,key}.pem, or prompt for paths)"
    else
      mkdir -p "$APP_DIR_ABS/ssl"
      CERT="$APP_DIR_ABS/ssl/cert.pem"
      KEY="$APP_DIR_ABS/ssl/key.pem"
      if [ ! -f "$CERT" ]; then
        if [ -n "${SSL_CERT_SRC:-}" ]; then
          if [ -f "$SSL_CERT_SRC" ]; then
            cp "$SSL_CERT_SRC" "$CERT" && log "cert copied from $SSL_CERT_SRC"
          else
            echo "[install] SSL_CERT_SRC 指向的文件不存在：$SSL_CERT_SRC"; exit 1
          fi
        else
          read -rp "证书文件路径 cert.pem（回车 = $APP_DIR_ABS/ssl/cert.pem）: " CERT_SRC || true
          if [ -n "$CERT_SRC" ]; then
            if [ -f "$CERT_SRC" ]; then cp "$CERT_SRC" "$CERT"; else echo "[install] 找不到证书文件：$CERT_SRC"; exit 1; fi
          fi
        fi
      fi
      if [ ! -f "$KEY" ]; then
        if [ -n "${SSL_KEY_SRC:-}" ]; then
          if [ -f "$SSL_KEY_SRC" ]; then
            cp "$SSL_KEY_SRC" "$KEY" && log "key copied from $SSL_KEY_SRC"
          else
            echo "[install] SSL_KEY_SRC 指向的文件不存在：$SSL_KEY_SRC"; exit 1
          fi
        else
          read -rp "私钥文件路径 key.pem（回车 = $APP_DIR_ABS/ssl/key.pem）: " KEY_SRC || true
          if [ -n "$KEY_SRC" ]; then
            if [ -f "$KEY_SRC" ]; then cp "$KEY_SRC" "$KEY"; else echo "[install] 找不到私钥文件：$KEY_SRC"; exit 1; fi
          fi
        fi
      fi
      if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
        echo "[install] 还缺证书/私钥（Cloudflare 用户：SSL/TLS → Origin Server → Create Certificate 下载）："
        echo "           1) 放进 $APP_DIR_ABS/ssl/cert.pem 与 $APP_DIR_ABS/ssl/key.pem 后重跑（幂等）；"
        echo "           2) 或重跑时直接输入两个文件路径；"
        echo "           3) 或设 SSL_CERT_SRC/SSL_KEY_SRC 环境变量后重跑。"
        exit 1
      fi
      chmod 600 "$KEY"
      # 反代上 HTTPS 后 manager 必须开 secure cookie
      grep -q '^NODE_ENV=' .env 2>/dev/null || echo 'NODE_ENV=production' >> .env
    fi
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY: write deploy/nginx/default.conf"
  fi
fi

# ---- nginx 运行时配置（生成物，不进 git）----
# 真相源 = deploy/nginx/default.conf.example（无域名 HTTP）与 tls-*.conf（域名模板）；
# default.conf 每次重跑都重新生成——线上改完不进 git，git pull 不再报 modified。
if [ "$DRY_RUN" = "1" ]; then
  log "DRY: write deploy/nginx/default.conf"
else
  if [ -n "$APP_DOMAIN" ]; then
    case "$TLS_MODE" in
      origin-ca) SRC=tls-origin-ca.conf ;;
      letsencrypt) SRC=tls-letsencrypt.conf ;;
      *) SRC=tls-none.conf ;;
    esac
    sed -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" \
        -e "s|__SSL_CERT_PATH__|$SSL_CERT_PATH|g" \
        -e "s|__SSL_KEY_PATH__|$SSL_KEY_PATH|g" \
        "deploy/nginx/$SRC" > deploy/nginx/default.conf
    log "nginx config written ($SRC)"
  else
    cp deploy/nginx/default.conf.example deploy/nginx/default.conf
    log "nginx config written (default.conf.example → default.conf，HTTP 直连)"
  fi
  NGINX_CONFIG_WRITTEN=1
fi

# ---- up ----
run docker compose up -d --build
# 重跑场景：default.conf 是 bind mount，文件变了 nginx 不会自己 reload
if [ "${NGINX_CONFIG_WRITTEN:-0}" = "1" ] && [ "$DRY_RUN" != "1" ]; then
  run docker compose restart nginx
fi

cat <<EOF

============================================================
Installed. (first boot pulls images — a few minutes on a fresh box)
  dir:     $APP_DIR_ABS
  watch:   cd "$APP_DIR_ABS" && docker compose logs -f manager
  manager: http://127.0.0.1:$MANAGER_PORT  (nginx on :80/:443 when domain set)
  login:   user \$(grep '^MANAGER_USERNAME=' .env | cut -d= -f2)
           password \$(grep '^MANAGER_INITIAL_PASSWORD=' .env | cut -d= -f2)
           (first login forces a password change)
============================================================
EOF
