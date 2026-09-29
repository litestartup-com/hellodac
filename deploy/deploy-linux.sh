#!/usr/bin/env bash
# deploy-linux.sh -- build and publish the DAC manager (and node) images to Docker Hub,
# then restart the local compose stack on the new images. Runs on the box that hosts
# the compose stack (the build box needs memory >= 4 GB; 33.11 with 1.93 GB is NOT it).
#
# Usage:
#   ./deploy/deploy-linux.sh                     # pull + build manager + push + redeploy
#   ./deploy/deploy-linux.sh --with-nodes        # also build/push the pinned DSH node image
#   ./deploy/deploy-linux.sh --backup            # snapshot the DB volume before redeploying
#   ./deploy/deploy-linux.sh --skip-push         # local-only build + redeploy (no Docker Hub)
#   ./deploy/deploy-linux.sh --rollback          # redeploy the previous SHA image (last resort)
#
# Immutable tags: images are tagged ${VERSION}-${GIT_SHA}. The same tag is never
# overwritten, so a rollback is just "point the compose env at the previous SHA".
# Secrets never enter the image: manager.config.yaml / .env / data/ stay on the host
# (bind mounts and named volumes), and .dockerignore excludes them.
set -euo pipefail

ORG="${DOCKER_ORG:-hellodac}"
VERSION="${DAC_VERSION:-1.0.0}"                    # single-version source of truth (release gate)
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.2}"           # node image DSH version to build with --with-nodes
BRANCH="${BRANCH:-main}"
COMPOSE_DIR="${COMPOSE_DIR:-.}"

SHA="$(git rev-parse --short HEAD)"
PREV_SHA="${PREV_SHA:-}"

# --- flags ---------------------------------------------------------------
WITH_NODES=0; BACKUP=0; SKIP_PUSH=0; ROLLBACK=0; TEST_FIRST=0
for arg in "$@"; do
  case "$arg" in
    --with-nodes) WITH_NODES=1 ;;
    --backup)     BACKUP=1 ;;
    --skip-push)  SKIP_PUSH=1 ;;
    --rollback)   ROLLBACK=1 ;;
    --test)       TEST_FIRST=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# --- 1. pull the pinned branch, refuse a dirty tree -----------------------
if [ "$ROLLBACK" -eq 0 ]; then
  if ! git diff --quiet; then
    echo "deploy: working tree is dirty -- commit or stash first (deploying over local edits is forbidden)." >&2
    exit 1
  fi
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
fi

if [ "$ROLLBACK" -eq 1 ]; then
  if [ -z "$PREV_SHA" ]; then
    echo "deploy: --rollback needs PREV_SHA=<git sha> in the environment." >&2
    exit 1
  fi
  SHA="$PREV_SHA"
  SKIP_PUSH=1
fi

# --- 2. credentials -------------------------------------------------------
if [ "$SKIP_PUSH" -eq 0 ]; then
  docker login || { echo "deploy: docker login failed (needs a Docker Hub access token)." >&2; exit 1; }
fi

# --- 3. gate before building (optional; runs inside a build container) ----
if [ "$TEST_FIRST" -eq 1 ]; then
  echo "deploy: running the release gate in a container (needs network for npm install)..."
  docker run --rm -v "$(pwd)":/repo -w /repo node:22-slim \
    sh -c "corepack enable && npm ci && npm run release:check -- --quick"
fi

# --- 4. build + tag + push ------------------------------------------------
MANAGER_TAG="${ORG}/dac-manager:${VERSION}-${SHA}"
echo "deploy: building ${MANAGER_TAG}"
docker build -t "$MANAGER_TAG" -t "${ORG}/dac-manager:latest" images/manager

NODE_TAG=""
if [ "$WITH_NODES" -eq 1 ]; then
  NODE_TAG="${ORG}/dac-node:${DSH_VERSION}-${SHA}"
  echo "deploy: building ${NODE_TAG}"
  docker build \
    --build-arg DSH_VERSION="$DSH_VERSION" \
    -t "$NODE_TAG" -t "${ORG}/dac-node:${DSH_VERSION}" \
    images/node
fi

if [ "$SKIP_PUSH" -eq 0 ]; then
  docker push "$MANAGER_TAG"
  docker push "${ORG}/dac-manager:latest"
  if [ -n "$NODE_TAG" ]; then
    docker push "$NODE_TAG"
    docker push "${ORG}/dac-node:${DSH_VERSION}"
  fi
fi

# --- 5. optional DB snapshot (the manager data dir is a bind mount: ./data) ----
if [ "$BACKUP" -eq 1 ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  echo "deploy: snapshotting ./data to backups/manager-data-${STAMP}.tgz"
  mkdir -p backups
  tar czf "backups/manager-data-${STAMP}.tgz" -C data .
fi

# --- 6. redeploy the stack -------------------------------------------------
cd "$COMPOSE_DIR"
MANAGER_VERSION="${VERSION}-${SHA}" docker compose pull manager
if [ -n "$NODE_TAG" ]; then
  DSH_NODE_IMAGE="$NODE_TAG" docker compose pull node-brain || true
fi
MANAGER_VERSION="${VERSION}-${SHA}" docker compose up -d --remove-orphans
if [ -n "$NODE_TAG" ]; then
  DSH_NODE_IMAGE="$NODE_TAG" docker compose up -d --remove-orphans
fi

# --- 7. healthcheck with automatic rollback --------------------------------
echo "deploy: waiting for the manager to come up (30 x 5s)..."
UP=0
for _ in $(seq 1 30); do
  if curl -fsS -m 3 http://127.0.0.1:8081/v1/health >/dev/null 2>&1; then UP=1; break; fi
  sleep 5
done
if [ "$UP" -eq 0 ]; then
  echo "deploy: manager did not come up -- rolling back to the previous image." >&2
  if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$SHA" ]; then
    MANAGER_VERSION="${VERSION}-${PREV_SHA}" docker compose up -d manager
  else
    echo "deploy: no PREV_SHA given; set it and run: ./deploy/deploy-linux.sh --rollback" >&2
  fi
  exit 1
fi
echo "deploy: ok -- manager ${MANAGER_TAG} is serving (admin API should answer 401 unauth)."
