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
#   ./deploy/deploy-linux.sh --help              # full usage: steps, flags, env overrides
#
# Immutable tags: images are tagged ${VERSION}-${GIT_SHA}. The same tag is never
# overwritten, so a rollback is just "point the compose env at the previous SHA".
# Secrets never enter the image: manager.config.yaml / .env / data/ stay on the host
# (bind mounts and named volumes), and .dockerignore excludes them.
set -euo pipefail

ORG="${DOCKER_ORG:-hellodac}"
# Identity is derived AFTER the git pull below -- a stale checkout must never tag the fresh build.
# Measured in production (2026-10-01): a deploy from a stale checkout captured SHA/defaults at the
# top, pulled mid-script, then tagged the manager 1.0.0-<stale sha> while it actually contained the
# post-pull v1.1.0 code, and the node line defaulted from the PRE-pull script text. Explicit env
# always wins: DAC_VERSION / DSH_VERSION.
VERSION="${DAC_VERSION:-}"
DSH_VERSION="${DSH_VERSION:-}"
BRANCH="${BRANCH:-main}"
COMPOSE_DIR="${COMPOSE_DIR:-.}"

SHA=""
PREV_SHA="${PREV_SHA:-}"

# --- help -------------------------------------------------------------------
usage() {
  cat <<'EOF'
deploy-linux.sh -- build, publish and redeploy the DAC container stack.

What it does, in order:
  0. docker cleanup: build cache + dangling images (df printed before/after).
     Tagged images and volumes are NEVER touched (tagged images are the local
     rollback path; volumes are data).
  1. git pull the deploy branch (refuses to run on a dirty worktree).
  2. docker login check (skipped with --skip-push).
  3. optional release gate in a node:22 container (--test).
  4. build linux/amd64 images with immutable tags:
       hellodac/dac-manager:${VERSION}-${GIT_SHA}  (+ :latest)
       hellodac/dac-node:${DSH_VERSION}-${GIT_SHA} (+ :${DSH_VERSION})  [--with-nodes]
  5. push to Docker Hub (skipped with --skip-push).
  6. optional snapshot of ./data into backups/ (--backup).
  7. docker compose pull + up -d (single invocation carrying both image variables).
  8. health-probe the manager from inside the compose network (30 x 5s); on failure
     print its last 50 log lines, and roll back to PREV_SHA when one is set.
  9. [--release] GitHub Release: push the clean manager version tag the release zip
     references (dac-manager:${VERSION}), build dist-release/dac-compose.zip in a
     node:22 container, then `gh release create v${VERSION}` with the CHANGELOG
     section as the body and the zip attached. Needs: gh authenticated on this
     machine, and the v${VERSION} git tag already pushed from the dev machine.
     Idempotent: an existing release is left untouched.

Flags:
  --with-nodes     also build and push the pinned-DSH-version node image
  --publish-only   stop after pushing: no backup, no compose pull/up, no healthcheck
                   (use it to refresh Hub images without touching the running stack)
  --release        step 9: publish the GitHub Release for v${VERSION} (gh CLI)
  --backup         tar ./data into backups/ before redeploying
  --skip-push      local build + redeploy only, no Docker Hub (also skips compose pull)
  --test           run `npm run release:check -- --quick` in a container before building
  --deep-clean     step 0 also removes ALL unused images and stopped containers
  --rollback       redeploy the PREV_SHA manager image instead of building (needs PREV_SHA)
  -h, --help       print this text

Environment overrides:
  DOCKER_ORG=hellodac   DAC_VERSION=<default: package.json version>
  DSH_VERSION=<default: the ARG in images/node/Dockerfile, matrix-guarded>
  BRANCH=main           COMPOSE_DIR=.       PREV_SHA=<git sha>
  HEALTH_URL=http://127.0.0.1:8081/v1/health   (probed inside the manager container)
  (identity is derived AFTER the git pull, so a stale checkout can never tag the fresh build)

Examples:
  ./deploy/deploy-linux.sh --test --with-nodes --release   # full release (images + stack + GitHub Release)
  ./deploy/deploy-linux.sh --test --with-nodes     # full redeploy without a GitHub Release
  ./deploy/deploy-linux.sh --skip-push             # local validation, no Hub
  BRANCH=feat-x ./deploy/deploy-linux.sh --skip-push   # try a feature branch on the server,
                                                       # without publishing it anywhere
  ./deploy/deploy-linux.sh --with-nodes --publish-only # refresh Hub images only
  ./deploy/deploy-linux.sh --with-nodes --publish-only --release # publish images + the GitHub Release, stack untouched
  PREV_SHA=abc1234 ./deploy/deploy-linux.sh --rollback
EOF
}

# --- flags ---------------------------------------------------------------
WITH_NODES=0; BACKUP=0; SKIP_PUSH=0; ROLLBACK=0; TEST_FIRST=0; DEEP_CLEAN=0; PUBLISH_ONLY=0; RELEASE=0; HELP=0
for arg in "$@"; do
  case "$arg" in
    --with-nodes)   WITH_NODES=1 ;;
    --backup)       BACKUP=1 ;;
    --skip-push)    SKIP_PUSH=1 ;;
    --publish-only) PUBLISH_ONLY=1 ;;
    --release)      RELEASE=1 ;;
    --rollback)     ROLLBACK=1 ;;
    --test)         TEST_FIRST=1 ;;
    --deep-clean)   DEEP_CLEAN=1 ;;
    -h|--help)      HELP=1 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 1 ;;
  esac
done
if [ "$HELP" -eq 1 ]; then usage; exit 0; fi
if [ "$PUBLISH_ONLY" -eq 1 ] && [ "$ROLLBACK" -eq 1 ]; then
  echo "deploy: --publish-only and --rollback contradict each other." >&2
  exit 1
fi
if [ "$RELEASE" -eq 1 ] && [ "$SKIP_PUSH" -eq 1 ]; then
  echo "deploy: --release pushes the clean version tag and needs the Hub -- it contradicts --skip-push." >&2
  exit 1
fi
if [ "$RELEASE" -eq 1 ] && [ "$ROLLBACK" -eq 1 ]; then
  echo "deploy: --release publishes the CURRENT version -- it contradicts --rollback." >&2
  exit 1
fi

# --- step 9 as a function: the GitHub Release (used by both the publish-only and the full path) ----
publish_release() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "deploy: --release needs the GitHub CLI (gh) on this machine -- install it or drop the flag." >&2
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "deploy: gh is not authenticated -- run 'gh auth login' once on this machine." >&2
    exit 1
  fi
  git fetch --tags origin >/dev/null 2>&1 || true
  if ! git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
    echo "deploy: git tag v${VERSION} does not exist -- push it from the dev machine first (a release pins a tag, not a branch)." >&2
    exit 1
  fi
  # The clean version tag the release zip's compose references (the build step only pushes SHA tags + latest).
  echo "deploy: publishing ${ORG}/dac-manager:${VERSION} (the tag dac-compose.zip references)"
  docker tag "${ORG}/dac-manager:${VERSION}-${SHA}" "${ORG}/dac-manager:${VERSION}"
  docker push "${ORG}/dac-manager:${VERSION}"
  # Build the release zip in the same container posture as the --test gate (no host node needed).
  echo "deploy: building dist-release/dac-compose.zip (DAC_VERSION=v${VERSION})..."
  docker run --rm -v "$(pwd)":/repo -v dac-npm-cache:/root/.npm -w /repo -e DAC_VERSION="v${VERSION}" node:22 \
    sh -c "npm ci --no-audit --no-fund --ignore-scripts && node scripts/make-release.mjs"
  # Notes = this version's CHANGELOG section; title = the section heading, DAC-prefixed.
  local notes; notes="$(mktemp)"
  awk -v v="${VERSION}" 'BEGIN{f=0} /^## v/ { if (f==1) {f=0} else if (index($0, "## v" v)==1) {f=1}; next } f==1 {print}' CHANGELOG.md > "$notes"
  if [ ! -s "$notes" ]; then
    echo "deploy: CHANGELOG.md has no '## v${VERSION}' section -- cannot compose the release notes." >&2
    rm -f "$notes"
    exit 1
  fi
  local subtitle; subtitle="$(awk -v v="${VERSION}" 'index($0,"## v" v)==1 { sub(/^## v[^ ]+[[:space:]]*/, ""); print; exit }' CHANGELOG.md)"
  local title="DAC v${VERSION}"
  if [ -n "$subtitle" ]; then title="DAC v${VERSION} ${subtitle}"; fi
  if gh release view "v${VERSION}" >/dev/null 2>&1; then
    echo "deploy: release v${VERSION} already exists -- left untouched (delete it on GitHub to re-create)."
  else
    gh release create "v${VERSION}" dist-release/dac-compose.zip --title "$title" --notes-file "$notes"
    echo "deploy: released v${VERSION}: $(gh release view "v${VERSION}" --json url -q .url)"
  fi
  rm -f "$notes"
}

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
else
  SHA="$(git rev-parse --short HEAD)"
fi

# --- 1b. derive the release identity from the REFRESHED tree ----------------
# (rollback note: VERSION comes from the current checkout -- when rolling back
# across a version boundary, pass the target build's DAC_VERSION explicitly.)
VERSION="${VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)}"
if [ -z "$VERSION" ]; then
  echo "deploy: cannot derive VERSION from package.json -- set DAC_VERSION explicitly." >&2
  exit 1
fi
DSH_VERSION="${DSH_VERSION:-$(sed -n 's/^ARG DSH_VERSION=\([^[:space:]]*\).*/\1/p' images/node/Dockerfile | head -1)}"
if [ -z "$DSH_VERSION" ]; then
  echo "deploy: cannot derive DSH_VERSION from images/node/Dockerfile -- set DSH_VERSION explicitly." >&2
  exit 1
fi
echo "deploy: identity -- manager ${ORG}/dac-manager:${VERSION}-${SHA}, node line ${DSH_VERSION}"

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

# --publish-only stops here: the Hub is refreshed, the running stack is untouched.
if [ "$PUBLISH_ONLY" -eq 1 ]; then
  if [ "$SKIP_PUSH" -eq 1 ]; then
    echo "deploy: --publish-only with --skip-push publishes nothing; did you mean a plain local build?" >&2
    exit 1
  fi
  echo "deploy: published ${MANAGER_TAG}$( [ -n "$NODE_TAG" ] && echo " and ${NODE_TAG}" ); no deployment performed."
  if [ "$RELEASE" -eq 1 ]; then publish_release; fi
  exit 0
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

# --- 9. GitHub Release (--release; only after a healthy deploy) -------------
if [ "$RELEASE" -eq 1 ]; then publish_release; fi
