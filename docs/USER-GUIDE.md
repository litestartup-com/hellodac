# DAC user manual

> Applies to v1.0.0. Written for people running DAC, not for people changing it —
> changes are in `CHANGELOG.md`, and how to build it is in the repository README.
> The Chinese README ([README.zh.md](../README.zh.md)) is the Chinese entry point; the
> interface itself ships in English and Chinese.

## 0. In one paragraph

DAC sits on top of DeepSeek Harness and provides the control plane: authentication,
conversation relay, brain dispatch, node and machine management, skill inventory, cost
accounting, backup and restore. The default install is three things:

| Role | What it does |
| --- | --- |
| **manager** | The control plane: sign-in, pages, scheduling, accounting, backups |
| **brain** | Cross-domain planning and dispatch; read-only on workspaces, execution is always delegated |
| **personal** | Your own workspace agent: reads files, writes files, leaves a git trail |

## 1. Install (either path; both scripts are idempotent)

### Linux server (containers, recommended)

```bash
mkdir -p /app && cd /app          # the current directory becomes the install directory
curl -fsSL https://raw.githubusercontent.com/litestartup-com/hellodac/v1.0.0/install.sh -o install.sh
bash install.sh                    # interactive: API key → password → domain → TLS mode
```

- Running `bash install.sh` asks for each answer (API key / initial password / domain — leave it
  empty for plain HTTP / TLS mode). For unattended installs, preset them:
  `DEEPSEEK_API_KEY=... APP_DOMAIN=... TLS_MODE=origin-ca bash install.sh`.
- Already-installed components (Docker / git / unzip) are **skipped**; re-running never
  overwrites configuration or data.
- **Moving the install**: move the whole directory, `cd` into it and re-run `bash install.sh`
  (idempotent — it re-pins the workspace host paths to the new location), then
  `docker compose up -d`.
- Installing into your home directory is refused on purpose. To see what the script would do:
  `DRY_RUN=1`.

### Windows (bare metal)

```powershell
irm https://raw.githubusercontent.com/litestartup-com/hellodac/v1.0.0/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

- Already-installed components (Docker / Node / git / DSH) are **skipped**; re-running never
  overwrites configuration or data.
- The only input is your **DeepSeek API key** (preset `DEEPSEEK_API_KEY=...` for a fully
  unattended install).
- `DRY_RUN=1` dry-runs, `--yes` skips confirmations.

### Domain + HTTPS (optional, origin-ca mode)

Answer the domain question and pick the origin-ca TLS mode, then supply the certificate in one
of three ways:

1. **Place it ahead of time (recommended)**: put the files at `ssl/cert.pem` and `ssl/key.pem`
   inside the install directory and press Enter at the prompt.
2. **Paste the paths** when prompted during the install.
3. Unattended: `SSL_CERT_SRC` / `SSL_KEY_SRC`.

With Cloudflare, the certificate comes from *SSL/TLS* → *Origin Server* → *Create Certificate*
(`cert.pem` + `key.pem`). Port 80 redirects to 443 with a 301, and the manager turns on secure
cookies automatically (`NODE_ENV=production` in `.env`). For Let's Encrypt instead: run once with
`TLS_MODE=letsencrypt` on port 80, then `certbot --nginx -d your.domain` on the host.

### After installing

Open `http://<server-ip>` (Windows bare metal: `http://127.0.0.1:8080`), sign in, **change the
password on first sign-in** (the UI forces it), and you are in. The initial password is the one
you set during install, or the one printed once in the manager's boot log.

### Upgrading

- **Bare metal**: `npm run update` in the install directory (backup → pull → build → health
  probe, with automatic rollback on failure).
- **Containers**: change `MANAGER_VERSION` in `.env` to the new tag, then `docker compose up -d`.
- **A node's DSH version**: use the version dropdown on the node's row in `/nodes`
  (containers rebuild with a new image; host processes reseed → reinstall → restart, about 1–2
  minutes).
- **Configuration migrates itself**: an older `manager.config.yaml` is upgraded at startup (the
  original is kept as `.pre-mig.bak`), so upgrading never means editing config by hand.

## 2. A tour of the interface

- **Brain card at the top of the sidebar** — the chief controller; expand it to see its sessions.
- **Session list** — click to chat; the landing page goes straight to the most recent session.
  Under the composer you get live context usage, and (when the endpoint supports it) per-session
  model selection and access-mode switching between read-only and workspace-write.
- **Nodes page (`/nodes`)** — three views: a **topology** of manager → machines → nodes with
  heartbeat edges, the **node** list (start / stop / restart / logs, plus the *New node* wizard
  in a side drawer), and the **machine** directory for hosts that joined through a node agent.
- **Runs page (`/runs`)** — every dispatched run across all workspaces, filterable by workspace
  and state, newest first.
- **Skills page** — what each workspace has installed (version = workspace git HEAD).
- **Cost page** — spend detail, per-workspace and per-model breakdown.
- **Bell** — in-app notifications: an offline machine, an abnormal node, a budget breaker, a
  finished brain dispatch.
- **⋮ menu at the bottom of the sidebar** — skills / archived / cost / audit / password, the
  **language switcher** (English ⇄ 中文) and the link to this project on GitHub.

## 3. Using the brain

Say what you want in a brain session, for example:

> "Rewrite the product workspace README in Chinese and commit it."

The brain plans, dispatches to the right node, and relays the result. Delegation frames appear in
the conversation and link to the dispatched session. **The brain is read-only on workspaces; it
always delegates execution**, and its daily dispatch budget (default $1/day) only stops automatic
dispatch — it never stops you.

## 4. Nodes, machines and workspaces

- **Node** = one DSH agent process with its own `DSH_HOME` (sessions, settings and attachments are
  invisible to other nodes).
- **Machine** = a server that joined through the node agent, so the manager can start, stop and
  read logs from that host. Machines page → *Add machine* produces a one-time join command
  (15 minutes, single use) to run on the target host.
- **Workspace** = the directory that node works on. Files are the source of truth: one git
  repository per workspace, one commit per run.
- **Adding a node**: nodes page → *New node* → name and workspace path; ports, gateway keys and
  `DSH_HOME` are allocated for you. Deleting a node stops managing it and keeps its files.

## 5. Skills

A skill is a `.skills/<name>/SKILL.md` file inside a workspace (instructions plus the tool-call
conventions). The skills page lists them per workspace; each agent reads its own workspace's
skills.

## 6. Scheduled runs

Unattended runs are configured through the scheduler API: a schedule, a target node and a task
description. Repeated failures disable the schedule instead of burning budget, and brain dispatch
stays behind the daily budget breaker.

## 7. Cost

Peak/off-peak pricing: weekdays 09:00–12:00 and 14:00–18:00 (Asia/Shanghai) are peak;
**weekends are off-peak all day**. Per-run cost, the monthly total and the per-workspace
breakdown all live on the cost page.

## 8. Backup / restore / update / autostart

| Action | Command |
| --- | --- |
| Backup (plus 15-minute automatic snapshots and encrypted node-home archives) | `npm run backup [-- list]` |
| Restore (detects whether the manager is running; database and node homes together) | `npm run restore -- latest` |
| DR drill (temporary directory, full chain: backup → delete → restore → assert) | `npm run drill` |
| Self-update (backup → pull → build → health probe, automatic rollback) | `npm run update` |
| Start on boot | `npm run service -- install \| uninstall \| status` |

Node homes (sessions, skills, settings) are packed into the automatic backups as **encrypted**
archives — the key is derived from `SESSION_SECRET`, so losing `.env` means losing the ability to
decrypt them. Archive retention matches the database snapshots (24h full → 30 days daily → 12
weeks weekly).

## 9. Troubleshooting

- **Port already in use** — the setup self-check names the port in red; change them with
  `--ports 3081,3082`.
- **DSH version warning** — the local DSH differs from the verified version;
  `--skip-version-check` overrides it at your own risk.
- **The brain does not answer** — check whether its node is online on the nodes page, and whether
  the budget breaker is on in the bell panel.
- **Forgot the login password** — `MANAGER_INITIAL_PASSWORD` in `.env` only applies while no user
  exists in the database; otherwise use the backup/restore procedure above.
- **A machine shows as unreachable** — its node agent has not sent a heartbeat for 90 seconds;
  check the agent service on that host (`systemctl --user status dac-agent`, or the scheduled task
  on Windows) and the firewall allow-list for the manager's egress IP.
