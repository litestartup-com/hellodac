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
#   ./deploy/deploy-linux.sh --deep-clean        # also drop all unused images + stopped containers
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
WITH_NODES=0; BACKUP=0; SKIP_PUSH=0; ROLLBACK=0; TEST_FIRST=0; DEEP_CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --with-nodes) WITH_NODES=1 ;;
    --backup)     BACKUP=1 ;;
    --skip-push)  SKIP_PUSH=1 ;;
    --rollback)   ROLLBACK=1 ;;
    --test)       TEST_FIRST=1 ;;
    --deep-clean) DEEP_CLEAN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# --- 0. free docker disk space before every run ----------------------------
# Only what is regenerable or already disposable is removed:
#   - the build cache (the biggest growth on a build box; rebuilding just costs time)
#   - dangling/untagged images
# Deliberately NOT removed by default: tagged images (the previous SHA image is the
# rollback path) and volumes (data). --deep-clean additionally drops every image no
# container uses (rollback then re-pulls from the Hub) and stopped containers.
# Volumes are never touched in either mode.
echo "deploy: docker disk usage before cleanup:"
docker system df
if [ "$DEEP_CLEAN" -eq 1 ]; then
  docker builder prune -a -f
  docker image prune -a -f
  docker container prune -f
else
  docker builder prune -f
  docker image prune -f
fi
echo "deploy: docker disk usage after cleanup:"
docker system df

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
# The FULL node image, not -slim: better-sqlite3 compiles native code through
# node-gyp during npm ci, which needs python3/make/g++ (the slim image lacks all
# three -- measured on the first AWS run).
if [ "$TEST_FIRST" -eq 1 ]; then
  echo "deploy: running the release gate in a container (needs network for npm install)..."
  docker run --rm -v "$(pwd)":/repo -w /repo node:22 \
    sh -c "corepack enable && npm ci && npm run release:check -- --quick"
fi

# --- 4. build + tag + push ------------------------------------------------
# Pinned to linux/amd64 (decision 2026-09-28): the fleet is amd64 today; buildx
# multi-arch is the upgrade path if an arm64 machine ever joins.
#
# Build contexts matter: the manager Dockerfile COPYs package.json/src/public/
# templates from the REPO ROOT (like compose: context .), while the node Dockerfile
# only needs images/node. Passing the wrong context makes every COPY fail with
# "failed to calculate checksum ... not found" -- measured on the first real run.
MANAGER_TAG="${ORG}/dac-manager:${VERSION}-${SHA}"
echo "deploy: building ${MANAGER_TAG}"
docker build --platform linux/amd64 -f images/manager/Dockerfile \
  -t "$MANAGER_TAG" -t "${ORG}/dac-manager:latest" .

NODE_TAG=""
if [ "$WITH_NODES" -eq 1 ]; then
  NODE_TAG="${ORG}/dac-node:${DSH_VERSION}-${SHA}"
  echo "deploy: building ${NODE_TAG}"
  docker build --platform linux/amd64 \
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
if [ "$SKIP_PUSH" -eq 0 ]; then
  MANAGER_VERSION="${VERSION}-${SHA}" docker compose pull manager
  if [ -n "$NODE_TAG" ]; then
    DSH_NODE_IMAGE="$NODE_TAG" docker compose pull node-brain || true
  fi
fi
# ONE up with both variables. Two separate invocations made the second one recreate
# the manager with compose's default tag (measured on the first AWS run: manager came
# back as :1.0.0 while the node carried the SHA tag). An empty DSH_NODE_IMAGE is safe:
# compose's ${DSH_NODE_IMAGE:-default} falls back to its own default when empty.
MANAGER_VERSION="${VERSION}-${SHA}" DSH_NODE_IMAGE="${NODE_TAG}" \
  docker compose up -d --remove-orphans

# --- 7. healthcheck with automatic rollback --------------------------------
# The manager publishes NO ports to the host in compose (nginx fronts the stack), so
# probing 127.0.0.1:8081 from the host can never work -- curl from inside the
# container instead (the manager image ships curl). Override with HEALTH_URL.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8081/v1/health}"
echo "deploy: waiting for the manager to become healthy (30 x 5s)..."
UP=0
for _ in $(seq 1 30); do
  if docker compose exec -T manager curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then UP=1; break; fi
  sleep 5
done
if [ "$UP" -eq 0 ]; then
  echo "deploy: manager did not become healthy -- last 50 log lines:" >&2
  docker compose logs --tail 50 manager >&2 || true
  if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$SHA" ]; then
    echo "deploy: rolling back manager to ${VERSION}-${PREV_SHA}" >&2
    MANAGER_VERSION="${VERSION}-${PREV_SHA}" docker compose up -d manager
  else
    echo "deploy: no previous SHA to roll back to (first deploy?). Fix the logs above, then re-run." >&2
  fi
  exit 1
fi
echo "deploy: ok -- manager ${MANAGER_TAG} is healthy inside the compose network."
