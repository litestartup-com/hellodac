#!/usr/bin/env bash
# Hive plan 2 P2: node container entrypoint. Idempotent: a restart does not copy again and does not overwrite existing settings.
set -euo pipefail

mkdir -p "$DSH_HOME"

# 0) Stale atomic-write lock cleanup: a leftover .credentials.yaml.lock from a crash makes every boot
#    time out on withFileLock (hit for real both on the production spine and on Windows; fact card dsh-facts §13) --
#    in the container's single-process model there is never a concurrent writer at the entrypoint, so a leftover
#    lock can only come from a dead process: remove it outright.
rm -f "$DSH_HOME/.credentials.yaml.lock"

# 1) Seed/upgrade the profile: missing from the volume, or the seed version differs from the image -> copy again (local, zero network)
SEED_CUR=""
SEED_NEW="$(cat /opt/dac-profile/.seed-version 2>/dev/null || echo unknown)"
[ -f "$DSH_HOME/profiles/dac-node/.seed-version" ] && SEED_CUR="$(cat "$DSH_HOME/profiles/dac-node/.seed-version")"
if [ ! -d "$DSH_HOME/profiles/dac-node" ] || [ "$SEED_CUR" != "$SEED_NEW" ]; then
  rm -rf "$DSH_HOME/profiles/dac-node"
  mkdir -p "$DSH_HOME/profiles"
  cp -a /opt/dac-profile "$DSH_HOME/profiles/dac-node"
  echo "[entrypoint] profile seeded into $DSH_HOME/profiles/dac-node (seed ${SEED_NEW:0:8})"
fi

# 2) Gateway static key: the environment variable is the truth (checklist A: derived files are never edited by hand).
#    The file is rewritten whenever it is missing, sits outside this plugin's namespace, or does not contain the
#    current GW_KEY -- a volume can hold the previous release's old key or old namespace (measured on the 0.1.1->0.1.2
#    upgrade: the dsh-api-gw section of the old settings.yaml held the same key string, so grepping for the key alone
#    wrongly concluded "already written" and skipped the rewrite -> the new facade namespace stayed empty, apiKeySet:false).
if [[ -n "${GW_KEY:-}" ]]; then
  NEED_WRITE=1
  if [ -f "$DSH_HOME/settings.yaml" ]; then
    if grep -q '^ohdsh-api-facade:' "$DSH_HOME/settings.yaml" 2>/dev/null \
       && grep -q "$GW_KEY" "$DSH_HOME/settings.yaml" 2>/dev/null; then NEED_WRITE=0; fi
  fi
  if [ "$NEED_WRITE" = "1" ]; then
    cat > "$DSH_HOME/settings.yaml" <<EOF
ohdsh-api-facade:
  apiKeys: ['$GW_KEY']
EOF
    chmod 600 "$DSH_HOME/settings.yaml"
    echo "[entrypoint] wrote $DSH_HOME/settings.yaml (GW_KEY refreshed)"
  fi
else
  echo "[entrypoint] ⚠ GW_KEY not injected -- gateway sandbox routing will 401 (GW_KEY_* in the manager's .env must be non-empty)"
fi

# 3) The brain token file ($HOME/.brain-auth, 0600): the DSH tool sandbox strips environment variables
#    containing TOKEN (DSH-FACTS §2), so the skill manual authenticates by reading the file. Idempotent: rewritten only when the content changed.
if [[ -n "${BRAIN_TOKEN:-}" && -n "${HOME:-}" ]]; then
  mkdir -p "$HOME"
  if [ ! -f "$HOME/.brain-auth" ] || [ "$(cat "$HOME/.brain-auth" 2>/dev/null)" != "$BRAIN_TOKEN" ]; then
    printf '%s' "$BRAIN_TOKEN" > "$HOME/.brain-auth"
    chmod 600 "$HOME/.brain-auth"
    echo "[entrypoint] wrote $HOME/.brain-auth"
  fi
fi

# 4) Model credentials: the DEEPSEEK_API_KEY environment variable ranks highest in the DSH credential layering, so no file is needed

# 5) Start: port and other arguments pass through to the web app (the manager's docker run command carries --port N)
exec dsh --profile dac-node --no-open "$@"
