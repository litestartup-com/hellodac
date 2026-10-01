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
#    The injection path is VERSION-GATED (0.2.0 corridor, upgrade card J1-04, fact card dsh-facts §18.5):
#    in the 0.1.7 corridor $DSH_HOME/settings.yaml became a one-shot import (renamed to
#    settings.yaml.imported at first boot) and ctx.settings.register was removed host-side -- plugin
#    configuration lives in the profile composition. So:
#      - legacy lines (0.1.2/0.1.5): the settings.yaml namespace mechanism (prod-verified). The file is
#        rewritten whenever it is missing, sits outside this plugin's namespace, or does not contain the
#        current GW_KEY -- a volume can hold the previous release's old key or old namespace (measured on
#        the 0.1.1->0.1.2 upgrade: the dsh-api-gw section of the old settings.yaml held the same key
#        string, so grepping for the key alone wrongly concluded "already written" and skipped the
#        rewrite -> the new facade namespace stayed empty, apiKeySet:false).
#      - 0.1.7+/0.2.x: regenerate the SEEDED profile's cordis.patch.yml at every boot = the image
#        baseline (/opt/dac-profile copy: webserver + privacy rows) + the facade config row built from
#        GW_KEY. The seeded patch is a derived file (the pristine baseline stays in the image layer), so
#        unconditional regeneration IS the red-line posture here -- no grep dance, env changes apply on
#        restart. Consequence on new lines: POST {prefix}/key bootstrap keys are memory-only -- the
#        durable key path is GW_KEY (the manager's .env is the truth either way).
#    NOTE the prerelease spelling: "0.1.5-rc.2" carries a DASH after the patch number -- a `0.1.5.*`
#    pattern silently misses it and routes the legacy line down the new path (measured crash-loop,
#    dsh-facts §18.10). Kept in sync with isLegacyDshLine in src/dsh-matrix.ts and the gate in
#    gen-node-profile.mjs (a standing check-docs.mjs assertion).
case "${DSH_VERSION:-}" in
0.1.2 | 0.1.2-* | 0.1.2.* | 0.1.5 | 0.1.5-* | 0.1.5.*)
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
  ;;
*)
  PATCH_FILE="$DSH_HOME/profiles/dac-node/cordis.patch.yml"
  if [[ -n "${GW_KEY:-}" ]]; then
    {
      cat /opt/dac-profile/cordis.patch.yml
      echo '- id: ohdsh-api-facade'
      echo '  config:'
      echo "    apiKeys: ['$GW_KEY']"
    } > "$PATCH_FILE"
    chmod 600 "$PATCH_FILE"
    echo "[entrypoint] regenerated $PATCH_FILE (baseline + facade key from GW_KEY)"
  else
    echo "[entrypoint] ⚠ GW_KEY not injected -- gateway sandbox routing will 401 (GW_KEY_* in the manager's .env must be non-empty)"
  fi
  ;;
esac

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
#    0.2.0 corridor (dsh-facts §19.9): boot the PROFILE-LOCAL bin when the profile carries the dsh
#    entry package (the new lines do) -- launcher and bundles then come from ONE tree. A mixed-tree
#    boot (global bin + profile bundles) double-instances dsh-app-boot: the root Include registry of
#    the booting instance is invisible to the profile-side config-editor reconcile, so every live
#    settings write from the native GUI is rejected ("profile reload requires the root Include
#    entry"). Legacy-line profiles have no local bin and keep the prod-proven global launch.
PROFILE_BIN="$DSH_HOME/profiles/dac-node/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ -f "$PROFILE_BIN" ]; then
  exec node "$PROFILE_BIN" --profile dac-node --no-open "$@"
fi
exec dsh --profile dac-node --no-open "$@"
