# Security Policy

DAC is a control plane: it holds credentials for the agent nodes it manages and can start,
stop and reach into them. We take reports about it seriously.

## Supported versions

| Version | Supported |
|---|---|
| 1.x (current release line) | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (*Security* → *Report a vulnerability*). If that is unavailable to you,
open a minimal issue that says only "security report — please contact me" and we will reach out.

Please include, as far as you can:

- what an attacker gains (read files? run commands? reach other nodes?),
- the version (`GET /healthz` plus the manager version in the sidebar),
- whether the deployment is bare metal or containers,
- a reproduction, or the exact request/response that shows it.

**What to expect:** we acknowledge within 3 working days, tell you whether we consider it a
vulnerability, and keep you posted until a fix ships. We will credit you in the release notes
unless you ask us not to.

## Threat model — what DAC does *not* defend against

Being explicit here saves everyone time:

- **The manager host is trusted.** Anyone who can run code there already has the database,
  the `.env` secrets and the node workspaces.
- **Agent output is untrusted text.** The UI escapes it, but the agent itself is instructed
  by prompts, mail and web pages; treat anything it writes as attacker-influenced.
- **`danger-full-access` means what it says.** That sandbox tier grants whole-machine
  capability and is meant for ops nodes you own, gated by approval cards on the node side.
- **Node facades are administrative surfaces.** They must not be exposed to the internet:
  keep them on loopback or behind a firewall allow-list for the manager's egress IP
  (the README has the exact rules), and use the SSH tunnel flow to reach a node's native GUI.

## Hardening checklist for operators

1. Change the initial password on first login (the UI forces it).
2. Keep `.env` (0600) and `manager.config.yaml` out of git — they hold the gateway keys.
3. Restrict node ports (default 3081/3082/…) to the manager host only.
4. Terminate TLS in front of the manager (the shipped nginx templates do it) and set
   `TRUST_PROXY` to the proxy's address rather than a hop count.
5. Turn on backups (`npm run backup`, or `backup.auto: true`) and keep `BACKUP_KEY` somewhere
   other than the machine you are backing up.
6. Rotate agent tokens from the machines page when a host changes hands
   (rotation keeps the old token valid for a 30-minute grace window by design).
