#!/usr/bin/env bash
# DAC — one-command install (Ubuntu 24, single-host container form:
# nginx + manager + the brain spine; the `personal` worker is created by the manager).
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
# would garble non-ASCII text (the one sanctioned exception to Chinese-only output).
set -euo pipefail

# Install dir = the directory this script runs in (install where you cd to; the APP_DIR environment variable can override it).
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

# ---- plan first ----
log "plan: Docker (skip if present) → download release ${DAC_VERSION} → .env (never overwrite) → compose up"
log "install dir: $(pwd)"
confirm "Continue?" || { log "aborted."; exit 0; }

# Installing into the home directory itself is refused by default: it would spread docker-compose.yml/.env/workspaces all over the house
if [ "$APP_DIR" = "." ] && [ "$(pwd)" = "$HOME" ]; then
  echo "[install] home directory ($HOME) detected -- create a dedicated directory first and run it there:"
  echo "           mkdir -p ~/appx && cd ~/appx && bash ~/install.sh"
  echo "          (to really install into the home directory itself: set APP_DIR=\$HOME and re-run.)"
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
    # The release bundle does not exist yet (tag not cut) or the download failed: fall back to a source clone.
    # Never rm -rf the install dir (with APP_DIR=. that would delete the user's own current directory) -- clone into a temp dir and move it in.
    log "release bundle unavailable — falling back to git clone (master)"
    TMP_CLONE="$(mktemp -d)"
    run git clone --depth 1 https://github.com/litestartup-com/hellodac.git "$TMP_CLONE"
    run cp -a "$TMP_CLONE"/. "$APP_DIR"/
    run rm -rf "$TMP_CLONE"
  fi
fi

# ---- secrets (the only manual input = the API key) ----
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

# ---- domain / TLS (empty = plain HTTP direct; with a domain it asks for the TLS mode) ----
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
  log "DRY: scripts/gen-env.sh .env + re-pin the host-side paths of host_volumes to ${APP_DIR_ABS}/workspaces"
else
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" MANAGER_PASSWORD="$MANAGER_PASSWORD" bash scripts/gen-env.sh .env
  # Review B2 + move re-pin (2026-09-20): the host-side workspace path at the start of a host_volumes line
  # (left = host machine, right = path inside the node container) is re-pinned on every run to the real absolute
  # path of the current install dir -- after moving the directory, cd into it and re-run install.sh to converge
  # (idempotent, nothing changes when it already matches).
  # Note it only matches "absolute path at line start + /workspaces ending": the container-side path right of the
  # colon and the agents.workspace line are untouched (they stay in the container's view, they do not follow the host dir).
  if [ -f manager.config.yaml ]; then
    sed -i -E "s|^([[:space:]]*)/[^ :]+/workspaces|\1${APP_DIR_ABS}/workspaces|g" manager.config.yaml
    log "config exists: host workspace path re-pinned to ${APP_DIR_ABS}/workspaces"
  else
    cp manager.config.container.example.yaml manager.config.yaml
    sed -i -E "s|^([[:space:]]*)/[^ :]+/workspaces|\1${APP_DIR_ABS}/workspaces|g" manager.config.yaml
    log "created: manager.config.yaml (host workspace path pinned to ${APP_DIR_ABS}/workspaces)"
  fi
  # Node containers share the uid of the host deploy user (workspace write permission matches on both sides; root server = 0)
  grep -q '^HOST_UID=' .env || echo "HOST_UID=$(id -u)" >> .env
  grep -q '^HOST_GID=' .env || echo "HOST_GID=$(id -g)" >> .env
  # Debt H1: the manager container runs as HOST_UID:HOST_GID -- the truth files and the data directory
  # must be released to the same owner (on a root deployment = 0:0 the chown is a no-op and the manager stays
  # root; dropping privileges only takes effect under a non-root deploy user; for docker.sock group access see
  # DOCKER_GID in gen-env.sh)
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
    # Canonical certificate location = <install dir>/ssl/cert.pem and key.pem (stated in the docs, they can be placed ahead of time);
    # entering the path of an existing certificate interactively, or the SSL_CERT_SRC/SSL_KEY_SRC environment variables, work too.
    # A new user can simply put the certificate downloaded from Cloudflare (SSL/TLS -> Origin Server) into the canonical location.
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
            echo "[install] the file SSL_CERT_SRC points at does not exist: $SSL_CERT_SRC"; exit 1
          fi
        else
          read -rp "Certificate file path cert.pem (enter = $APP_DIR_ABS/ssl/cert.pem): " CERT_SRC || true
          if [ -n "$CERT_SRC" ]; then
            if [ -f "$CERT_SRC" ]; then cp "$CERT_SRC" "$CERT"; else echo "[install] certificate file not found: $CERT_SRC"; exit 1; fi
          fi
        fi
      fi
      if [ ! -f "$KEY" ]; then
        if [ -n "${SSL_KEY_SRC:-}" ]; then
          if [ -f "$SSL_KEY_SRC" ]; then
            cp "$SSL_KEY_SRC" "$KEY" && log "key copied from $SSL_KEY_SRC"
          else
            echo "[install] the file SSL_KEY_SRC points at does not exist: $SSL_KEY_SRC"; exit 1
          fi
        else
          read -rp "Private key file path key.pem (enter = $APP_DIR_ABS/ssl/key.pem): " KEY_SRC || true
          if [ -n "$KEY_SRC" ]; then
            if [ -f "$KEY_SRC" ]; then cp "$KEY_SRC" "$KEY"; else echo "[install] private key file not found: $KEY_SRC"; exit 1; fi
          fi
        fi
      fi
      if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
        echo "[install] certificate/private key still missing (Cloudflare users: SSL/TLS -> Origin Server -> Create Certificate to download):"
        echo "           1) put them at $APP_DIR_ABS/ssl/cert.pem and $APP_DIR_ABS/ssl/key.pem, then re-run (idempotent);"
        echo "           2) or just type the two file paths when re-running;"
        echo "           3) or set the SSL_CERT_SRC/SSL_KEY_SRC environment variables and re-run."
        exit 1
      fi
      chmod 600 "$KEY"
      # Once the reverse proxy serves HTTPS the manager must enable secure cookies
      grep -q '^NODE_ENV=' .env 2>/dev/null || echo 'NODE_ENV=production' >> .env
    fi
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY: write deploy/nginx/default.conf"
  fi
fi

# ---- nginx runtime config (a generated artifact, never in git) ----
# Truth source = deploy/nginx/default.conf.example (no domain, HTTP) and tls-*.conf (domain templates);
# default.conf is regenerated on every re-run -- a live edit never enters git, so git pull no longer reports modified.
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
    log "nginx config written (default.conf.example -> default.conf, plain HTTP)"
  fi
  NGINX_CONFIG_WRITTEN=1
fi

# ---- up ----
run docker compose up -d --build
# Re-run scenario: default.conf is a bind mount, nginx does not reload by itself when the file changes
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
