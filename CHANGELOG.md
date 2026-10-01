# Changelog

## v1.1.0 — the DSH 0.2.0 corridor (2026-10-01)

**The default node line is now DSH `0.2.0-rc.2`**, paired with facade v0.2.5 (gateway
commit `398ea94`). The 0.1.x rows stay supported and verified on their existing facade
pin — a verified pairing is never re-pinned without a re-smoke.

What ships in 1.1.0:

- **Version matrix** — `0.2.0-rc.2` enters as the first row (the default for new nodes,
  installers and container images); `0.1.5-rc.2` / `0.1.2-rc.1` remain for existing fleets.
- **The corridor adaptations, version-gated on one legacy-line predicate** (kept
  word-for-word identical in four places under a standing CI assertion):
  - the durable gateway-key path moves from `settings.yaml` (a one-shot import on the new
    hosts, with the facade's settings layer removed) to the profile's `cordis.patch.yml`
    composition row — the manager, the node container entrypoint, the node agent and the
    upgrade script all place the key by version, and an upgraded node **reuses** its
    settings-era key so the `.env` truth never drifts;
  - the DeepSeek session-log upload (which defaults **on** from the 0.1.7 corridor) is
    explicitly opted out in every managed node profile;
  - `patchReload` is dropped from new-line manifests (removed from the host contract);
  - the peer-pin table grows to the full closure (36 pins) with regenerated frozen locks
    on both the bare-metal and container paths — a profile-local-bin boot without the
    closure dies with 33 failed plugin imports;
  - join scripts gate Node ≥ 22.19 (the 0.2.x engines floor).
- **Fixes found by the corridor work**:
  - switching a node's DSH version wrote `dsh_version` but not the paired `gateway_ref` —
    a stale ref survived the switch and outranked the matrix row (on a 0.2.0 host a
    pre-corridor facade kills the question/approval card chain *silently*);
  - the agent-spawn facade-ref fallback now resolves through the matrix row instead of a
    constant that only ever matched the legacy lines;
  - a gateway-key rotation on an agent node no longer triggers the minutes-long
    dependency reinstall;
  - `scripts/upgrade-node-version.mjs` now ships the explicit peer pins and the frozen
    lock with the install (previously a legacy-line upgrade installed without them and
    the node crashed on boot), and resolves the facade ref per target version.
- **Deployment defaults flipped to the new line**: node image `hellodac/dac-node:0.2.0-rc.2`
  (compose fallback, container example config, `deploy-linux.sh`, release bundle,
  `install.ps1`). The image re-exports `DSH_VERSION` so the entrypoint can gate the key
  path, and its `GATEWAY_REF` build arg defaults empty so the paired facade ref always
  resolves per version.

Verified on a real bare-metal `0.2.0-rc.2` node: the gateway full-chain smoke with a real
model turn, question + approval card chains end to end, the typewriter streaming over the
frozen wire (facade 0.2.5 re-emits `assistant/chunk`), the manager client smoke, and the
manager E2E (chat relay, usage ledger, workspace git audit). The GUI-token startup line is
byte-identical to the 0.1.5 shape, and the session-history event vocabulary matches what
the 0.1.5 production nodes already emit — no chat translation changes were needed.

> **Upgrading an existing node to 0.2.0**: the DSH session-log format migrates V3→V4
> **one-way** on first boot. Back the node up first (`npm run backup`; container nodes
> also need their `/data` volume). Then use the version dropdown on the nodes page, or
> `scripts/upgrade-node-version.mjs 0.2.0-rc.2` for a whole host (stop the stack first —
> the script refuses to run against busy ports).

## v1.0.0 — first public release (2026-10-01)

**One Manager. A Fleet of Agents.** The first public release of DAC (Dispatched Agent
Cluster), an MIT control plane for fleets of containerized agent nodes across servers.

What ships in 1.0.0:

- **Fleet management** — one manager, machines joined by a node agent (Linux `join.sh` with a
  systemd system service, Windows `join.ps1` with a scheduled task), nodes as container workers or
  host processes, with start/stop/restart/logs, per-node DSH version pinning, and a live
  topology view (manager → machines → nodes, heartbeat edges).
- **Unified conversation** — streaming chat against any node, tool cards, inline question and
  approval handling, per-session model selection and access-mode switching
  (`read-only` / `workspace-write` / `danger-full-access`), conflict surfacing when two turns
  commit the same workspace.
- **API access** — the gateway plugin exposes each node's agent through one authenticated
  prefix, so third-party clients get the same agents the UI has.
- **Operations** — audit log, peak/off-peak costing with daily budget breakers, encrypted
  backups with a restore drill, self-update with health probe and automatic rollback,
  in-app notifications for offline machines and abnormal nodes.
- **Bilingual UI** — English by default, Chinese switchable per user; new languages are one
  JSON file plus one registry line.
- **Safe defaults** — node ports bind loopback only, the node agent is zero-native-dependency
  and outbound-only, dangerous operations are gated by approval cards, agent tokens rotate
  with a 30-minute grace window, first login forces a password change.

Changes made *for* the public release, relative to the pre-release internal line:

- Renamed the product to **DAC** (was "Oh! dsh"); repository and images follow
  (`hellodac/dac-manager`, `hellodac/dac-node`).
- Removed two half-finished pages from the UI: the per-agent board view and the scheduled-jobs
  page. Both back ends remain (the board feeds brain output, the scheduler API still runs
  unattended work) — only the unfinished surfaces are gone.
- Made English the default language and moved every user-visible string into translatable
  locale files (UI, API error details, notification text, CLI output, workspace templates).
- Added `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and PR templates.

Hardening and UI polish landed on the public line before the tag (2026-09-25/26):

- **Fleet reliability** — the node-agent now installs as a systemd *system* service (the
  user-unit form never started on boot and raced itself on every SSH login); node spawn is
  idempotent so reconcile sweeps cannot double-start a node, and a machine's nodes resume
  from disk on their own after a reboot without waiting for the manager. Verified on a
  clean machine: join → reboot → nodes back in seconds, zero manager involvement.
- **Language switching actually works** — `?lang=` was processed after the auth guard on
  protected pages, which swallowed the cookie before the redirect; the switch now runs as a
  global request hook ahead of every preHandler.
- **Nodes UI decluttered** — a row now shows status, id, owner and running version, with
  start/stop/restart, version switching, logs and native access moved into a ⋮ menu; the
  sidebar overflow menu became a fixed two-level structure with Language and About as
  flyouts; run summaries clamp to two lines with expand/collapse.
- **Audit & password pages restyled** — the audit log is a hairline timeline with semantic
  state dots instead of stacked cards; the password page's submit button is deep ink rather
  than accent blue (the login button stays blue).
- **Docs & polish** — product screenshots in both READMEs; the tagline split from the
  description; the sidebar tagline localized (Chinese: "an agent cluster under unified dispatch"); icon
  spacing, a proper mail glyph and an inline copy bubble in the About flyout.
- **Guards** — new tests pin the anchor-vs-button contract, icon-sprite names, DOM wiring
  against the built pages, the password-button colour contract, the view-switch contrast,
  and the `?lang=` hook ordering, so these regressions fail in CI rather than in a browser.

## Unreleased (1.1.2 candidate · upgrades need no manual config edits, 2026-09-22)

- **Versioned config migration (P0)**: `manager.config.yaml` gains a `config_version` field plus the
  migration chain in `src/config/migrations.ts` (0 → CURRENT, +1 per step); loadConfig migrates an old
  config before parsing it — the original file is backed up to `.pre-mig.bak` first, migration notes go
  into warnings (visible in the boot log), and a version ahead of the chain or a broken chain fails loud;
  check-docs asserts the chain stays complete (change the shape and forget the migration = CI red)
- **Node version-switch API + page dropdown (P1/P2)**: `POST /api/nodes/:id/version` has two branches —
  process = change the pin plus chain alignment (the implementation is shared with align-version); container
  = change the image tag and rebuild right away (closing the gap where a container node answered 409 with no
  alternative path); audit `node_version_change`; a "DSH version" dropdown on the node row (fed by the
  matrix, pending marked) — switching a version needs zero sed
- **Capability four · Fleet M1 (node-agent multi-machine form)**: after Q1–Q5 were signed off in the design
  doc `fleet-agent-architecture.md`, this landed per `plan-fleet-agent.md` — `spawn.runner=agent + host` in
  config as the source of truth; the agent registration chain (a one-time join token is exchanged for an
  identity, the token hash is stored in the DB, revocation); command queue and event channel (DB-persisted,
  claimed by long polling, results / heartbeat / logs reported back, a 90s online decision); the supervisor
  agent branch (remote lifecycle goes through the command queue, spawn-result subscription with a fast-failure
  chain); the node-agent process itself (zero native dependencies, DSH pinned into its own prefix, backoff
  self-healing after losing contact, a 401 clears the identity and re-registers; join.sh/join.ps1); derived
  delivery (profile / seed / fleet.md arrive with the spawn payload and are written idempotently); the
  machines page UI (agent directory + join command + node host column + wizard host dropdown). Fixes: a
  profileDependencies expansion-order bug (a 0.1.5 node picked up 0.1.2 bundles) and microtask starvation
  (an instant resolve chain starved the timer).
- **Capability four · Fleet M1 local pilot and three fixes (2026-09-23)**: the M1 local pilot ran the whole
  chain on this Windows machine (agent registration → the machine shows up → create an agent node through
  the API → facade live → chat turn → start/stop/restart/logs), and it proved out and fixed three classes
  of problem:
  1. **Two Windows platform traps** — the agent's `execFileSync('npm')` hit ENOENT with no shell (npm is a
  .cmd shim) and `spawn(bin.js)` hit EFTYPE (CreateProcess has no shebang); both became platform-aware
  calls (shell: true / on win32 run through node);
  2. **The 0.1.5 family's floating ranges plus legacy peer-skipping, a double kill** (fact card dsh-facts §14)
  — every dsh@0.1.5-rc.2 dependency is a `^` range, 0.1.5-rc.3 is already on the registry, so a fresh install
  drifts the whole tree and `--legacy-peer-deps` skips every peer → the node crashes the moment it starts;
  the fix = ship the package-lock tree snapshot with the profile (profile-locks.ts) + 26 explicit peer pins
  (LEGACY_PEER_PINS, kept word-for-word in sync between profile.ts and the container generator) +
  `patchReload: startup` (no hard HMR dependency) + the agent preferring the profile-local bin;
  3. **The agent node readiness window went 30s → 120s** (a remote first start = dependency install plus a
  full boot, measured at 40–90s); the compatibility signal now goes through the version matrix (a verified
  0.1.5-rc.2 row no longer reports a false incompatibility).
  The pilot also confirmed: a worker agent node has no model credentials (by design; credential delivery
  belongs to M3), and copying `.credentials.yaml` onto the same machine made chat turns work.
- **Capability four · Fleet M3-3 earlier alerts (§13 patch, 2026-09-23)**: the fleet watchdog
  (`src/fleet/watchdog.ts`) runs every 30s — an agent heartbeat timeout (90s) and an agent node's supervisor
  going offline fire the in-app bell on the edge (`agent_offline` / `node_offline`, and `*_recovered` when it
  comes back); unread dedup keeps a manager restart from flooding the bell; only agent-runner nodes report,
  local process/docker nodes stay out of scope. Measured locally: stop the agent task → the bell shows
  "machine offline"; restart it → "machine recovered".
- **Capability four · Fleet M4-1 agent token rotation (2026-09-23)**: `POST /api/agents/:id/rotate`
  (the "rotate key" button on the machines page) — only an online machine can rotate (409 when offline, so
  nobody bricks it); the new token reaches the agent only through a `config.deliver` command (it never goes
  back to the browser); the old token enters a 30-minute grace window (a lost ack must not brick the agent),
  the grace is cleared only when the agent reports success and rolled back automatically when it reports
  failure; migration 18 (prev_token_hash/prev_set_at) plus the `agent_token_rotated` audit. Local E2E:
  rotate → the agent's on-disk identity switches to the new token → the ack converges → heartbeats continue
  on the new token.
- **Capability four · Fleet M3 ops-node unlock (2026-09-23)**: a danger-full-access workspace puts
  `ALLOW_FULL_ACCESS` into the spawn payload → the agent writes `allowFullAccess: true` into the facade
  settings (a risk warning in the facade log is the backstop). Measured on 192.168.33.11: the ops33 node's
  host.describe reports `allowFullAccess: true` and fullAccess is unlocked on the chat capability surface
  (composer accessMode=danger-full-access). The approval-card path is existing facade machinery; a real card
  turn waits for model credentials on that machine (credential handling is part of M3 acceptance).
- **Capability four · Fleet M2 cross-machine pilot (2026-09-23, measured on 192.168.33.11)**: a Linux
  machine joined this manager through join.sh (systemd user unit) — the cross-machine node spike02
  (0.1.5-rc.2) was created / probed live / streamed logs / started and stopped / recovered from a dropped
  connection (stopping and starting the agent → the bell reports offline and then recovery + the node stays
  alive + reconcile converges) / the facade firewall allowlist (ufw admits only the manager's egress IP, and
  a non-allowlisted source is refused, measured). 4 real bugs were fixed on the way: (1) the readiness
  probe moved after the spawn result (a cold install is no longer killed by the 120s window, which used to
  trigger a stop + retry storm); (2) an agent install-complete marker (.installed-ok) skips warm reinstalls
  (a slow disk makes them take minutes); (3) the join scripts gate Node ≥22.18 (the DSH 0.1.5 launcher needs
  import.meta.main; on 22.17 a node dies the moment it is started with an empty log — measured as a silent
  exit 0); (4) a remote workspace path on an agent node passes through untouched (Windows resolve turned
  /root/... into C:\root\..., and the facade rejects a non-absolute cwd). Chat turns reach the model layer
  (missing credentials are expected by design; credential handling belongs to M3).
- **Capability four · Fleet M4-4 metric collection (2026-09-23)**: every 60s the agent reports host metrics
  alongside its heartbeat (CPU busy share as an integer ×10, memory/disk total and used, uptime, platform) —
  CPU from the difference between two samples (`os.cpus()` time slices), disk through `fs.statfs`; the manager
  stores them (migration 20 `agent_metric`, 7-day retention with automatic cleanup), `GET /api/agents/:id/metrics`
  serves a trend (≤1440 points), and the machine row shows the latest snapshot (CPU/memory/disk share). 2
  red-green cases plus local E2E (two samples from a real agent: a 1.4% CPU delta stored and put into the
  snapshot).
- **Capability four · Fleet M4-3 atomic agent self-update (2026-09-23)**: `POST /api/agents/:id/update`
  (online only) packs the manager's static agent.mjs/runtime.mjs/update.mjs plus a sorted, concatenated
  sha256 into an `agent.update` command; after verifying it the agent stages it to `.next` → exits with a
  non-zero code (on Windows a batch 5s restart loop is the backstop, systemd Restart=always supports it
  natively) → at startup it swaps atomically (current → `.prev`, one generation kept) → the new code loads;
  **automatic rollback on an instant crash**: a restart within 90s + a swap within 10 minutes + a previous
  generation present = the new code is crash-looping → restore `.prev`; version negotiation = the
  registration/heartbeat reports agentVersion (migration 19), and the machines page shows a "pending update"
  badge compared against managerVersion. Local E2E: automatic update → v1.1.1 takes effect; injecting a bad
  runtime → instant crash → automatic rollback → the machine is online again.
- **Capability four · Fleet M4-2 log cap and backpressure boundary (2026-09-23)**: on the agent side
  `node.log` is capped at 50MB — it rotates automatically when the cap is exceeded before a spawn (one
  generation kept as `.1` for crash diagnosis; on Windows the rename is safe once the old fd is closed);
  both READMEs gained a "scale and backpressure boundaries" section (channel rate-limit matrix / log cap /
  the recommendation of ≤50 machines per manager and why); check-docs guards `NODE_LOG_MAX_BYTES`.
- **Capability four · Fleet M3-1 ops nodes (2026-09-23)**: the wizard/API admit a third sandbox tier,
  `danger-full-access` (the whole machine, the Q2 decision) — a provision schema tier + a wizard dropdown
  (marked high risk) + a separate yellow-text confirmation (approval cards / audit / credential handling);
  the three check-docs guards cover it; both READMEs gained the "operations assistant node (ops)" deployment
  recipe (placement rule D3, approval cards as the backstop, server-local credentials never delivered through
  the manager, node-side allowFullAccess unlock).

## 1.1.1 — three online-acceptance fixes (2026-09-20)

- **Production disk lesson**: 15-minute automatic snapshots plus packing the node home directory filled the
  disk on a small production box — `backup.auto` now defaults to **off** (`manager.config.yaml` must set
  `auto: true` explicitly); a manual `npm run backup` and the pre-update backup are unaffected
- **Directory-move self-healing**: every install.sh run re-pins the host-side workspace paths in
  `host_volumes` to the current install directory (a generalisation of review item B2 — the old
  implementation pinned them once at first creation, so after a move they pointed at the old directory).
  Now **installing into any directory, then moving it, `cd` into it and re-running `bash install.sh`, converges**;
  check-docs gained a move re-pin guard
- **The container form refuses host-process nodes** (a production lesson): the manager image carries an
  `OHDSH_DEPLOY_FORM=container` marker — provision returns 400 `host_process_unavailable` for an explicit
  `runner: process` (the old behaviour was a misleading "bin.js not found" error), and the wizard disables
  the "host process" option in step; bare-metal deployments (including mixed docker.sock deployments) carry
  no marker and are unrestricted

## 1.1.0 — three node capabilities · direct tunnels / host nodes / multiple versions (2026-09-20)

> Design/plan: `hive/nodes-install-version-tunnel.md`, `hive/plan-node-capabilities.md`;
> the underlying facts: the S0 spike (dsh-facts §11) — an nginx domain reverse proxy is rejected by the
> upstream loopback-pinned surface (PRIVILEGED_METHODS / dynamicCordisRunner), so the full-feature native
> GUI channel = a user-side SSH tunnel (the browser is loopback).

- **Capability three v1**: the config source of truth is `endpoints.*.access`
  (ssh_user/ssh_host/ssh_port/gui_port/local_port, defaulting to 22/3080) — the manager records only *how to
  connect*, **the SSH private key never enters config**; `POST /api/nodes/:id/access` writes it back (lock +
  atomic write + `node_access_update` audit + clear to remove); the node page's "native GUI" card gives the
  tunnel command + copy + one-click open, the 0.1.5 `?token=` is captured on the spot from the node log
  (three sources: buffer/docker/file) and follows restarts and rotation automatically; node GUI ports are
  published on the host loopback only (compose node-brain + dynamic worker PortBindings 127.0.0.1). UX
  polish (acceptance feedback): the tunnel command gained `-N` (tunnel only) + `-o ExitOnForwardFailure=yes`
  + an optional `ssh_key` private-key path (`-i`, the path only, never the key); **a local loopback node
  needs no tunnel** — the card opens "direct local" instead (the URL uses the port and token the node reports
  in its startup line)
- **Capability one · host node install**: profile generation/installation/keys/dependency commands moved into
  the shared module `src/host-node/` (used by both setup and provision); the profile dependencies gained
  `@deepseek-ai/dsh` itself — after an isolated install, spawn prefers the profile's own bin.js (falling back
  to the global one, for existing installs); the wizard offers the forms "auto / container worker / host
  process", host process needs a yellow-text confirmation + the `node_create_host` audit, and an explicit
  docker runner with no sock mounted returns 400
- **Capability two · per-node DSH versions**: the version matrix in `src/dsh-matrix.ts` (the (dsh ↔ facade)
  pairing table, the single source of truth; `src/dsh-version.ts` degrades to a re-export shim); both matrix
  rows, 0.1.2-rc.1 / 0.1.5-rc.2, are now **verified** — 0.1.5 went through the server-side smoke15 full-chain
  smoke (host.describe synthesised version / session.create / session.prompt with a real turn / the mux frame
  stream user→assistant→turn/end; installing it needs `--legacy-peer-deps` and running it needs node ≥22.19,
  fact card dsh-facts §12); the wizard/API support pinning `dsh_version` per node — the profile pins the
  target version, yaml is written only when set explicitly (the default follows the first matrix row and does
  not freeze), an unknown version is 400, a pending pairing warns in yellow; the node page shows the
  configured version + drift detection + one-click `POST /api/nodes/:id/align-version` (reseed → installDeps →
  restart on the isolated bin, audit `node_align_version`, container nodes refused with an explicit 409);
  container images follow the pin as `ohdsh/dsh-node:<dshVersion>`; `profileInstallCommand`/background installs
  append `--legacy-peer-deps` automatically for the matrix pairing (the 0.1.5 ERESOLVE fix, dsh-facts §12);
  the upgrade script was generalised into `scripts/upgrade-node-version.mjs` (target version as a parameter,
  idempotent, `--dry-run`, `.pre-<version>.bak` backup, `.env` image tag bumped too), while the old
  `upgrade-012-win.mjs` stays as a compatibility shell, and the check-docs guard was upgraded to assert "the
  script's SUPPORTED table lines up row by row with the matrix". UI completion (acceptance feedback): a
  "version drift" yellow tag + an "align version" button on the node row (confirm → 202 accepted); a
  "DSH version" dropdown in the wizard (fed by GET /api/nodes supportedDsh, not hardcoded in the frontend),
  and an explicit pin shows as "pinned x.y.z" on the node row

## 1.0.4 — security fixes + four rounds of technical-debt repayment (2026-09-12)

> ⚠️ **Upgrade notes**:
> - `engines` tightened to **Node ≥ 22** (required by better-sqlite3 13) — an upgrade on an older Node is
>   rejected, so upgrade Node first;
> - after the upgrade the first start validates `.env` centrally through zod: a `SESSION_SECRET` shorter
>   than 32 characters, and the like, fail loud and refuse to start;
> - backup artifacts became ciphertext: a new backup's DB snapshot is `<file>.db.enc` and `.env` is
>   `.env.enc` (GCM encryption); old plaintext snapshots still restore (compatible read), but **new backups
>   no longer write plaintext**.

### Security and data correctness (round one · release-gate fixes, R1–R10 + S3)

- **R2 backup encryption**: DB snapshots and `.env` both go through AES-256-GCM (staged through a temp
  directory, so a crash leaves no plaintext); restore branches on `.enc` and decrypts, and tampering always
  fails
- **R3/R4 backups read the source of truth**: the DB path / backup directory / liveness port used by the
  backup and update CLIs all come from `loadConfig()`; the config copy is explicitly "for manual reference
  only" and no longer claims a complete restore
- **R5 mux first-connect criterion**: a real `onopen` is the fact of "was connected", so a failed first
  connect no longer broadcasts a bogus reconnect (this fixed the billing-chain bug where a run was
  mislabelled "result unknown")
- **R6 config write lock on every path**: every config write in provision/setup/auth goes through
  `withConfigLock`; YAML `doc.errors` is checked twice, on input and on read-back
- **R7 governance rules passed through**: the post-write re-validation in `applyWrites` uses the same agent
  rules as before the write (it no longer degrades to DEFAULT_RULES)
- **R8 apiproxy subscription leak**: a rejected, throwing or timed-out prompt always unsubscribes in
  try/finally; `finish` is an idempotent gate
- **R9 a single reconcile path**: every hot change in provision goes through `reconcileAll` (scoped with
  onlyNodes, so it does not drag up a cold node the user stopped by hand)
- **S3 rate limits on every mutating endpoint**: node start/stop and add/delete 20/min, internal
  dispatch/continue/crons 60/min, password change 10/min on the same tier as login
- **R10 release-gate patches**: `gen-env.sh` now writes `HOST_UID/HOST_GID` (so a compose container and the
  deploying user share a uid) — previously, a setup that skipped install.sh and used gen-env directly
  (CI compose-e2e) left the container falling back to 1000 while host files belonged to 1001, the manager
  could not write data → an endless `SQLITE_CANTOPEN` loop and 502s from nginx everywhere; the node image's
  `/data` volume root is 777 with `HOME=/data` — when a container runs as HOST_UID while a named volume
  inherits the image's 1000 owner, `mkdir /data/profiles` hit EACCES, the node restarted forever and worker
  claiming timed out; the manager image puts the `/app` directory out for writing — the atomic write of
  truth files (`.tmp` + rename) needs a writable directory, otherwise dynamic provisioning hit EACCES and a
  500 writing `/app/.env.tmp`; `writeFileAtomic` gained an EBUSY fallback — a file-level bind mount
  (`./.env:/app/.env`) cannot be replaced by a rename on Linux, so a failed rename falls back to writing in
  place (the same trade-off as clearing the initial password in auth.ts, with an injected-rename regression
  test); **provision's new endpoints switched to the 0.1.2 facade main line** — the old 0.1.1 wiring
  (`prefix:/api` + `key_ref:''`) made the liveness probe against host.describe return 401, so a new node
  could never go live (proven by a compose-e2e worker live timeout; the yaml and in-memory endpoints and both
  the docker/process branches were fixed together, key_ref=GW_KEY_<name> being the same key as sandbox);
  **node volume backup/restore moved to attach streaming** (`runToolIo`) — the old implementation bound the
  manager container's backup directory as if it were a host path, and dockerd resolved it by host semantics to
  a ghost directory, so the tar artifact could not be read (ENOENT); now only the named volume is bound and
  the data travels over stdin/stdout, `tar czf -`/`tar xzf -` (3 docker-runner cases + 1 nodebackup
  stub case in regression)
- **E8 tighter protocol-frame discrimination**: zod discrimination of the six RPC/mux/translate frame types
  (a shape mismatch is dropped fail-loud, upstream is not guessed at)
- **Card-loss chain fixed (2026-09-17, proven in production: cards occasionally missing, ask_user_question
  stuck)**: the root cause = question/approval frames are a **one-shot broadcast with no recovery channel** —
  the facade broadcasts once, at the instant the question appears, so missing any one of the mux disconnect
  window / manager restart / SSE stream break loses the card forever. The fix is five parts: (1) on
  reconnect the runner no longer kills a turn that is waiting for a human answer (awaitingHuman>0) (a turn
  with a pending question can never be finished, and the answer arrives separately through respond);
  (2) pending cards (pendingCards) are persisted independently of the turn lifecycle, replayed both on a GET
  refresh and on an SSE reconnect (after hello), and cleared when resolved or after a 15-minute TTL;
  (3) a successful answer/decision synthesises a resolved frame on the spot (without depending on the
  upstream broadcast, the card always closes); (4) **a facade recovery channel**: the answerer keeps the
  pending payload plus `GET /api-gw/v1/answerer/pending` (pinned into gateway commit `b592b4f`), and the
  manager gained the port capability `pendingAsks` — at turn start, on mux reconnect and on GET refresh it
  fetches on demand the card frames lost to a disconnect window or a restart (deduplicated by rpcId);
  (5) every dropped mux frame, disconnect and reconnect is logged (`setMuxLogger` → app.log). 7
  red-green cases (runner 2 / mux 2 / chat 3)

### Backend treatment (round two)

- **E1–E4 giant-module split**: runner (the turn state machine in `runner/turn.ts`), chat (three layers:
  relay / turn orchestration / CRUD), provision (a four-stage provisioning pipeline) and setup (a six-phase
  main) each narrowed
- **E9 usage aggregation moved to drizzle** + money fields in the API unified under a MicroUsd name (no more
  leaking the bare column names cost/peakCost)
- **E16 three ADRs** (turn-driven semantics / the two usage rules / a chat turn-count retrospective) + the
  wire reality moved into the fact card `dsh-facts.md` §9

### Frontend treatment (round three)

- **F1 chat.js split into five modules** (reducer/render/wire/composer/state, 2146 → 876 lines) + 80
  frontend cases
- **F6 apiJson unifies the Result layer**: the "check status + read JSON + build a banner" boilerplate is
  gone from eight pages, and the error banner is shared and escapes automatically
- **F3/F4** SSE reconnect and polling consolidated (autoReconnect / poll); **F5** the site's only unescaped
  innerHTML sink fixed; **F7** ui.js switches on @ts-check and joins the CI typecheck

### Tests and toolchain (round four)

- **C3 a shared test harness**: 13 duplicated test-helper files converged; the mux reconnect test
  mocks the clock (saving 12s); supervisor tests use a fake process throughout (no real node -e process any more)
- **C4 a coverage gate**: production code only, lines 80 / branch 70 / funcs 75 into CI
- **D4 dependencies caught up**: better-sqlite3 13 + zod 4 + @types 9.6.0
- **D5 the version number injected at build time** (exposed by /api/status as managerVersion) + central zod
  validation for env + exactOptionalPropertyTypes tightened

## 1.0.3 — switching to the 0.1.2 main line (2026-09-10)

> ⚠️ **Upgrade notes**: the order for switching to the main line = **stop the stack first → run the upgrade
> script → restart → smoke**. The script backs up `*.pre-012.bak` on its first run (including `.env`, not
> committed), and any error rolls back from the backup.
> Linux containers: `node scripts/upgrade-012.mjs` (manager.config.yaml wiring + the .env image tag);
> Windows bare metal: `node scripts/upgrade-012-win.mjs` (profile → facade / key minting / .env sync / global
> DSH; a pre-flight port check refuses when a port is taken).

### Road repair (rewriting the manager's upper layer)

- **SessionDriver became a port**: the upper layer depends on the port alone, and the facade driver becomes a
  plug (liveness probing moved to probeVersion, the release semantics entered the port, zero behaviour
  change); the unplug acceptance ran FakeSessionDriver as a pure in-memory driver over 8 apiproxy end-to-end
  cases
- **A narrow ACP bridge**: an SDK client relay + narrow-surface mapping (permissions → approval frames; the
  usage/history gaps recorded), accepted with 4 fake-agent cases + a runner unplug re-run
- **A single reconcile path**: reconcileAll as the one entry point (images / run convergence / orphans /
  fleet / node claiming), shared by boot and provision; healOnly treats offline only; the supervisor
  reconciles health at runtime (consecutive probeLive failures turn a node offline, self-healed in the same
  tick)
- **An explicit apiproxy prefix now takes effect**: a precondition for the 0.1.2 facade wiring (omitting it
  keeps the old /api default)

### Switching to the 0.1.2 main line

- COMPAT_DSH_VERSION goes to `0.1.2-rc.1`, the gateway 0.1.2 gate-ified package name **ohdsh-api-facade** is
  wired everywhere (image / node profile / entrypoint namespace / default tag), and endpoints go through
  `/api-gw/v1/proxy` + key_ref (the same key as sandbox_key_ref)
- **upgrade-012.mjs**: a one-shot manager.config.yaml wiring migration (idempotent / backs up / exits with
  code 2 and fails loudly when a key is missing) + the `.env` image tag migration
  (`DSH_NODE_IMAGE→0.1.2-rc.1`, `MANAGER_VERSION→1.0.3`; gen-env is idempotent and does not overwrite old
  values, so the bump has to be explicit)
- **upgrade-012-win.mjs**: the Windows bare-metal node upgrade (profile → facade / key minting / .env sync /
  global DSH), a pre-flight port check (8080/3081/3082/3090 taken = refuse, the EPERM half-destroyed-tree
  lesson made permanent), `--dry-run` / `--force`, idempotent
- Node profile dependency install **pnpm→npm** (the pnpm@9 prerelease range stopped resolving and the
  pnpm@11 allowlist stopped working, two walls proven; npm with the same version set is all green in the
  local e2e)
- Windows setup resolveGatewayKey switched to the facade namespace (the old dsh-api-gw section is not read,
  with a regression test)
- The entrypoint key decision gained a namespace condition (a leftover 0.1.1 settings.yaml carrying the same
  key string is no longer misjudged and skipped)
- compose dropped `--trusted-host` (the 0.1.2 CLI removed it); the image's stage-2 user creation tolerates an
  existing 1000:1000
- **Two-track verification**: a Linux container cluster + a Windows production node, smoke all PASS (three
  nodes apiKeySet:true)
- The bilingual documentation rule landed: README.md (English) + README.zh.md (Chinese) as separate files,
  mixing the two forbidden

## 1.0.2 — security and deployment hardening (2026-09-08)

> ⚠️ **Upgrade notes**: this version's database migration sets `must_change_password` to 1 on existing
> accounts — the first login after the upgrade forces a password change. Make sure you still remember the
> current password, or that `MANAGER_INITIAL_PASSWORD` is still in `.env`; a user who has lost both is locked
> out (there is no reset path today — only rebuilding `data/manager.db`, which loses the run history).

### Security

- **H1 manager container non-root + group-level docker.sock de-privileging + nginx internal ACL**: the
  manager image ships `USER 1000:1000`; compose runs it as `HOST_UID:HOST_GID` and injects the host docker
  group GID through `group_add` (`DOCKER_GID` is detected by gen-env.sh and written into .env); install.sh
  grants `.env`/`manager.config.yaml`/`data`/`workspaces` to HOST_UID; four nginx templates add a private
  network ACL to `/api/internal/` (a second door besides the token). Note: when the deploying user is root
  (HOST_UID=0) the container stays root — closing that fully needs socket-proxy/rootless docker (later)
- **H2 full provision rollback**: side effects are reordered as "prepare → DB → truth files → memory →
  process", any failing step is undone in reverse order, so a half-provisioned ghost node cannot happen; a
  failed attempt is recorded in the audit
- **H3 fleet.md commits narrowed**: `git commit -- fleet.md` is path-limited (other changes the user already
  staged are never dragged along) + a per-agent commit lock, so they no longer step on each other's
  index.lock
- **Login rate limiting no longer trusts forwarding headers**: trustProxy tightened, the rotating
  X-Forwarded-For bypass is closed (proven by a regression test)
- **helmet + CSP `script-src 'self'`** with the full set of security headers (HSTS only in the TLS form),
  checked line by line against the frontend with zero conflicts
- **A password change revokes other sessions** + the initial password is erased from `.env` (together with
  forced password change on first login and CSRF self-healing)
- **BRAIN_TOKEN lives at `$HOME/.brain-auth`** (0600, never in a workspace and never travelling with git)

### Deployment

- **nginx's runtime default.conf became a generated artifact**: the template was renamed
  `default.conf.example`, install.sh regenerates it on every run and gitignore excludes it — a production
  git pull no longer reports it as modified. Upgrading an old deployment:
  `git checkout -- deploy/nginx/default.conf && git pull`, then re-run `bash scripts/gen-env.sh .env` (to add
  DOCKER_GID) and `docker compose restart nginx`
- CI extended: lint + frontend cases (md.test into CI) + deployment gates (assertions that the manager is
  non-root / group_add / the nginx internal ACL)

### Regression tests

- `fleet-doc.test.ts`: an assertion that a file the user pre-staged never enters a manager commit
- `provision.test.ts`: an assertion that a failed DB write leaves zero residue on six surfaces (memory /
  supervisor / yaml / .env / directories / DB)
- `scripts/check-docs.mjs`: deployment gates for the manager image USER, compose group_add/DOCKER_GID and the
  nginx internal ACL

## 1.0.1 — product-grade single-machine edition (Hive plan 2, 2026-09-05)

From "feature v1" to "product-grade v1": one-command install, containerisation, the security trio, full
backups, version governance.

### Deployment and distribution

- **Two one-command paths**: `install.sh` (Ubuntu containers: nginx + manager + the brain's spine) /
  `install.ps1` (Windows bare metal); both skip already-installed components idempotently, and the only
  manual input = the API key
- `install.ps1` carries a UTF-8 BOM (measured before release: without one, Windows PowerShell 5.1 reads the
  Chinese as GBK → a ParserError, so the officially recommended path failed outright)
- A failed clone in `install.ps1` falls back to the codeload zip (measured before release: on networks in
  China both github.com git and raw time out while codeload answers 200)
- Node dependencies in a Windows install are pinned to `npx pnpm@9` (measured before release: a global
  pnpm 11 ignores the build allowlist and native dependencies are not built); setup pre-generates the
  first-start password into `.env` (generating it under a hidden-window start loses it)
- **Containerisation**: two images, dsh-node / manager (dependencies frozen at build time, zero install at
  runtime) + a compose spine + the manager driving worker containers through docker.sock (label-based
  reconcile, with the wizard / start / stop / log semantics unchanged)
- Three-mode nginx TLS templates + idempotent key generation in `gen-env.sh` + a release-bundle generator + a
  release checklist (internal to maintainers)

### Security (D2/D4)

- **The first login forces a password change** (existing accounts are converted once too) + a password page;
  a new password is ≥ 10 characters
- **CSRF double submit**: every non-GET `/api/*` is validated (login and the brain's internal API are exempt)
- **CSRF self-healing**: when a pre-upgrade session lacks the csrf cookie, the server answers 403 and
  re-issues it, and the frontend retries once with the new cookie (a live fix for the 403 seen when changing
  a password after a Windows upgrade)
- **An audit trail**: login success and failure / password changes / node operations / backups, with the
  sidebar audit page
- `.env` is tightened to 600 on POSIX

### Backup (D3)

- A node home (chats/skills/settings) is **archived encrypted** (AES-256-CBC, key derived from
  SESSION_SECRET)
- restore extended: the DB and the node home roll back together
- A DR drill, `npm run drill` (permanent in CI; measured end to end at 0.2s, RTO target ≤ 5 minutes)

### Version governance (R4)

- `COMPAT_DSH_VERSION` as the single source of truth; a setup self-check table (node/pnpm/git/dsh red-green +
  a port-in-use check; a failure exits in red, **no half-success state**)
- A node hostVersion alert (a yellow tag on /nodes + a log line); the profile bundle pins a version; the
  gateway pins a commit
- Linux `detectDshBin` fixed (POSIX `command -v` + `npm root -g`)

### Engineering

- The docs/notes split (public docs/ = roadmap + user manual), README rewritten (a zero-dead-link CI
  assertion, hand-written test counts forbidden)
- CI: test + drill + the fresh-boot journey E2E + typecheck + audit + build + check-docs
- The test suite went 335 → 360+

## 1.0.0 — Hive v1 (2026-09-05)

The single-host multi-node edition is released: the default install = manager (HQ) + brain (chief
controller) + personal (workspace), one command and you are up in 5 minutes.

### Hive core

- **The brain**: the global coordination entry (work orders / fleet queries / drafting scheduled jobs),
  read-only on workspaces and always delegating execution; an internal REST API (127.0.0.1 only +
  `X-Brain-Token`) + a skill manual (skill + curl, no MCP)
- **Delegation frames**: the brain's chat page shows the dispatch trail, and clicking jumps back to the
  dispatched chat; a `brain_done` in-app notification
- **Chat reuse**: a task of the same kind continues in a chat of the same name, and an empty chat is reused
  first (`POST /api/internal/chats/:id/prompt`)
- **A daily budget breaker for the brain**: `brain.daily_budget_usd` (default $1/day), it blocks dispatch
  only and never a human, answering 409 in plain words

### Multiple nodes (fleet)

- The manager starts/stops/restarts multiple DSH nodes (a five-state supervisor + exponential backoff +
  disabling after consecutive failures)
- The `/nodes` page: the full node table + start/stop/restart + a log drawer; a `N/N` ready count in the
  sidebar
- **The new-node wizard**: a node = a workspace created as a pair (advanced settings collapsed for
  customisation), ports allocated automatically, files first + automatic rollback on failure; deleting =
  unmanaging (the directory on disk stays)
- Every node has its own DSH_HOME / port / gateway key (`GW_KEY_*` goes into `.env`)

### Chats and concurrency

- Multi-turn chat (chat adopt / SSE relay / cancel / double-billing protection), chat archive and restore,
  empty-chat cleanup (vacate)
- **Concurrent chats on the same agent**: serial within a chat, parallel between chats (DSH native semantics
  + a git commit lock + conflicts surfaced as `run.conflict`)
- The home page opens the most recent chat directly; archiving takes one hop without a double refresh

### Small platform pieces (P5)

- The `/skills` inventory page (files are the truth + a version comparison against the workspace git HEAD) +
  the agreed location for the skill repository
- In-app notifications (bell + unread badge): cron success and failure / a budget breaker / a finished brain
  dispatch
- Pricing: peak/off-peak windows + **off-peak all weekend long** (`pricing.weekends_off_peak`)

### Operations (P6)

- Database backup/restore: 15-minute automatic snapshots, a retention policy (all kept for 24h → daily for 30
  days → weekly for 12 weeks),
  `npm run backup/restore`
- Running as a service: `npm run service -- install/uninstall/status` (Windows Task Scheduler / systemd user
  unit)
- Self-update: `npm run update` (backup → pull → build → liveness probe, automatic rollback on failure)
- E2E smoke: `node scripts/smoke.mjs` (login → chat turn → brain dispatch → notification, the whole chain)

### Engineering

- Explicit SQLite migrations with `schema_version`; the test suite all green (the count is asserted by CI);
  zero frontend build (hash-versioned assets)
- The documentation split: public `docs/` (user manual + roadmap) and internal `notes/`
  (design/plan/research) as layers
