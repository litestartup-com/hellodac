/**
 * Capability three v1 (2026-09-20): capture the native GUI's startup line and token from a node's log.
 *
 * A node prints `dsh web: http://127.0.0.1:<port>/?token=...` when it starts (0.1.5-rc.2 and up carry a
 * bootstrap token, rotated on every restart; 0.1.2 and below have only the bare URL -- the GUI has no auth, so
 * the tunnel is the only gate). The manager takes the log from supervisor.logs() for a process node or docker
 * logs for a container node, and this function reads the **last** startup line = the current state.
 */

export interface GuiTokenCapture {
  /** Whether a GUI startup line appeared at all (false = the node is still starting / the log does not have it yet). */
  found: boolean
  /** The bootstrap token on 0.1.5+; null in the token-less era (0.1.2 and below). */
  token: string | null
  /** The full base address from the startup line (http://127.0.0.1:<real GUI port>/); null when not captured. */
  url: string | null
}

// Two shapes: 0.1.5+ `http://127.0.0.1:3080/?token=...`; 0.1.2- `http://127.0.0.1:3080`
// (a bare URL with no trailing slash and no token -- both lines turned up in the spike and in container testing).
const GUI_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)(\/\?token=([A-Za-z0-9_-]+))?/

export const captureGuiToken = (logs: string): GuiTokenCapture => {
  let found = false
  let token: string | null = null
  let base: string | null = null
  for (const line of logs.split(/\r?\n/)) {
    const match = GUI_LINE.exec(line)
    if (match === null) continue
    found = true
    // Rotated on restart: a later line overwrites an earlier one -- the last one is the current state
    token = match[3] ?? null
    base = `${match[1]}/`
  }
  return { found, token, url: base }
}

/** Assemble the browser URL: the localPort on the user's own loopback plus the captured token. */
export const guiOpenUrl = (localPort: number, capture: GuiTokenCapture): string | null => {
  if (!capture.found) return null
  const base = `http://127.0.0.1:${localPort}/`
  return capture.token === null ? base : `${base}?token=${encodeURIComponent(capture.token)}`
}

/**
 * The direct URL for a local loopback node (the no-tunnel form): the real GUI port from the startup line
 * (the port the node printed itself is the truth -- do not guess at the one in the config), with the token appended.
 */
export const guiDirectUrl = (capture: GuiTokenCapture): string | null => {
  if (!capture.found || capture.url === null) return null
  return capture.token === null ? capture.url : `${capture.url}?token=${encodeURIComponent(capture.token)}`
}
