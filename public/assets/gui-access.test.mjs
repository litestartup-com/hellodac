import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guiTunnelCommand } from './gui-access.js'

import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const ACCESS = { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088 }

test('Debt P1 regression: tunnel command -- -N pure tunnel, -p omitted on port 22, the other fields pasted in as-is', () => {
  assert.equal(
    guiTunnelCommand(ACCESS),
    'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3088:127.0.0.1:3080 ubuntu@10.0.0.5',
  )
  assert.equal(
    guiTunnelCommand({ ...ACCESS, sshPort: 2222, guiPort: 3082, localPort: 4090 }),
    'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4090:127.0.0.1:3082 -p 2222 ubuntu@10.0.0.5',
  )
})

test('UI polish regression: private key path -- the command carries -i when ssh_key is set, and omits it when empty/unset', () => {
  assert.equal(
    guiTunnelCommand({ ...ACCESS, sshKey: 'C:\\Users\\you\\.ssh\\id_ed25519' }),
    'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3088:127.0.0.1:3080 ubuntu@10.0.0.5 -i "C:\\Users\\you\\.ssh\\id_ed25519"',
  )
  assert.ok(!guiTunnelCommand(ACCESS).includes(' -i '), 'no private key configured = the ssh default key is used')
  assert.ok(!guiTunnelCommand({ ...ACCESS, sshKey: '' }).includes(' -i '))
})

// UI slimming (DAC v1.0.0): the three former "native GUI cards" (tunnel, direct, config entry) were an
// always-visible block on the right of every node row. Once a row became "status + ID + menu", nothing
// called them, so they went away with the inline UI; the tunnel command and "open GUI" moved into the
// native access drawer (which computes the command live from the form values). All that is left here is
// the regression on command assembly -- it is still production code, the card rendering is not.
