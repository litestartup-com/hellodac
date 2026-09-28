// @ts-check
// Capability three v1 (2026-09-20): the tunnel command for a node's native GUI -- pure function layer, unit-tested
// （gui-access.test.mjs）。
// Red line: an SSH private key never enters the manager -- only the "how to connect" command is generated,
// and the key stays on the user's machine (ssh_key is only the *path* of a local private key, never its content).
//
// UI slimming (DAC v1.0.0): this file used to carry three always-visible cards (tunnel, direct, config entry)
// on the right of every node row. Once a node row became "status + ID + menu", nothing called them: the
// tunnel command and "open GUI" moved into the native access drawer (configure once, use once, they belong
// together), so the three cards went away with the inline UI and only the genuinely shared builder stays.

/**
 * The tunnel command the user runs in a local terminal: local loopback localPort -> the node host's
 * loopback guiPort. The -p flag is omitted for port 22; -i is added when a key path is configured.
 * -N (tunnel only, no shell) plus -o ExitOnForwardFailure=yes (fail loudly when the local port is taken).
 * @param {{ sshUser: string, sshHost: string, sshPort: number, guiPort: number, localPort: number, sshKey?: string | null }} access
 * @returns {string}
 */
export const guiTunnelCommand = (access) => {
  const portPart = Number(access.sshPort) !== 22 ? ` -p ${Number(access.sshPort)}` : ''
  const keyPart = typeof access.sshKey === 'string' && access.sshKey !== '' ? ` -i "${access.sshKey}"` : ''
  return `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${Number(access.localPort)}:127.0.0.1:${Number(access.guiPort)}${portPart} ${access.sshUser}@${access.sshHost}${keyPart}`
}
