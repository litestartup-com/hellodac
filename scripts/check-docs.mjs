// scripts/check-docs.mjs — a CI gate (Hive plan 2 P0/P6):
// 1) in-repo markdown links in README.md must point at files that exist (external http/mailto links are not checked);
// 2) README/CHANGELOG must not hand-write a test count (the number is asserted by CI, so it can never drift);
// 3) deployment file integrity: local files referenced by compose exist; the container example config parses and has the right shape.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

// ---- 1) Dead links: an in-repo relative link must resolve to a real file ----
for (const rel of ['README.md']) {
  const text = readFileSync(join(root, rel), 'utf8')
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1].trim()
    if (target === '' || /^(https?:|mailto:)/i.test(target)) continue
    const path = resolve(root, target.replace(/^\.\//, ''))
    if (!existsSync(path)) failures.push(`${rel}: dead link \`${target}\``)
  }
}

// ---- 2) Hand-written test counts: README/CHANGELOG must not contain "N tests/cases" ----
for (const rel of ['README.md', 'CHANGELOG.md']) {
  const text = readFileSync(join(root, rel), 'utf8')
  const hits = text.match(/\d{2,4}\s*(tests?|测试|用例)/gi) ?? []
  if (hits.length > 0) failures.push(`${rel}: hand-written test count (forbidden) -> ${hits.join(', ')}`)
}

// ---- 3) Deployment file integrity ----
try {
  const compose = parseYaml(readFileSync(join(root, 'docker-compose.yml'), 'utf8'))
  const services = compose?.services ?? {}
  for (const name of ['nginx', 'manager', 'node-brain']) {
    if (services[name] === undefined) failures.push(`docker-compose.yml: missing service ${name}`)
  }
  for (const rel of [
    'deploy/nginx/default.conf.example',
    'images/node/Dockerfile',
    'images/node/entrypoint.sh',
    'images/node/gen-node-profile.mjs',
    'images/manager/Dockerfile',
    'manager.config.container.example.yaml',
    'scripts/gen-env.sh',
  ]) {
    if (!existsSync(join(root, rel))) failures.push(`deployment file missing: ${rel}`)
  }
  const example = parseYaml(readFileSync(join(root, 'manager.config.container.example.yaml'), 'utf8'))
  if (example?.endpoints?.brain?.sandbox_key_ref !== 'GW_KEY_B') failures.push('container example config: brain is missing sandbox_key_ref=GW_KEY_B')
  if (example?.endpoints?.personal?.spawn?.runner !== 'docker') failures.push('container example config: personal should use the docker runner')
  if (!Array.isArray(example?.backup?.docker_volumes) || !example.backup.docker_volumes.includes('dac-brain')) {
    failures.push('container example config: backup.docker_volumes should include dac-brain')
  }
} catch (error) {
  failures.push(`deployment file validation failed: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 4) Debt H1: the manager container is non-root + the docker.sock privilege drop is wired + nginx closes the internal surface ----
try {
  const managerDockerfile = readFileSync(join(root, 'images/manager/Dockerfile'), 'utf8')
  if (!/^\s*USER\s+\d+:\d+\s*$/m.test(managerDockerfile)) {
    failures.push('images/manager/Dockerfile: missing a USER directive (the manager container must be non-root)')
  }
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
  if (!/group_add/.test(compose)) failures.push('docker-compose.yml: manager is missing group_add (docker.sock is reached through the host docker group GID)')
  if (!/\$\{DOCKER_GID:/.test(compose)) failures.push('docker-compose.yml: group_add should reference DOCKER_GID (gen-env.sh probes the host docker group)')
  for (const rel of ['deploy/nginx/default.conf.example', 'deploy/nginx/tls-none.conf', 'deploy/nginx/tls-origin-ca.conf', 'deploy/nginx/tls-letsencrypt.conf']) {
    const conf = readFileSync(join(root, rel), 'utf8')
    if (!conf.includes('location /api/internal/')) failures.push(`${rel}: missing the /api/internal/ proxy block`)
    if (!conf.includes('deny all')) failures.push(`${rel}: /api/internal/ is missing its private-network ACL (deny all)`)
  }
} catch (error) {
  failures.push(`H1 deployment hardening validation failed: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 5) Static assertions for the container deployment red lines (compose-e2e proved the four traps on
//          2026-09-14 for the first time; the retrospective is in the design library's
//          manager/facts/container-deploy-facts.md -- the CI-side net for red lines A/B/C/D) ----
try {
  // Red line A: every bootstrap path must write HOST_UID/HOST_GID (the container uid = the host file owner; missing -> SQLITE_CANTOPEN)
  const genEnv = readFileSync(join(root, 'scripts/gen-env.sh'), 'utf8')
  for (const v of ['HOST_UID', 'HOST_GID']) {
    if (!genEnv.includes(`ensure ${v} `)) failures.push(`scripts/gen-env.sh: must write ${v} (red line A: the container uid and the host file owner share one source)`)
  }
  // Red line B: the runtime uid is parameterized -> a directory written at runtime must be uid-agnostic (named volume root 777, HOME on a writable volume)
  const nodeDockerfile = readFileSync(join(root, 'images/node/Dockerfile'), 'utf8')
  if (!nodeDockerfile.includes('chmod 777 /data')) failures.push('images/node/Dockerfile: the /data volume root must be chmod 777 (red line B: with HOST_UID≠1000 the named volume owner gives EACCES)')
  if (!nodeDockerfile.includes('HOME=/data')) failures.push('images/node/Dockerfile: HOME=/data is required (runtime writes such as .brain-auth must land on a writable volume)')
  // Red line C: atomic writes of the source-of-truth files (.tmp+rename) need a writable directory (/app is owned by root from the image layer)
  const managerDockerfile2 = readFileSync(join(root, 'images/manager/Dockerfile'), 'utf8')
  if (!managerDockerfile2.includes('chmod 777 /app')) failures.push('images/manager/Dockerfile: /app must be made writable (red line C: the atomic .tmp+rename write of the source-of-truth files needs directory write permission)')
  // Red line D: node volume backup must stream through runToolIo (using an absolute path inside the container as a bind source = a host path hallucination)
  const nodebackup = readFileSync(join(root, 'src/nodebackup.ts'), 'utf8')
  if (!nodebackup.includes('runToolIo')) failures.push('src/nodebackup.ts: node volume backup must go through runToolIo (red line D: never bind a backup directory inside the container as if it were a host path)')
} catch (error) {
  failures.push(`container deployment red line assertion failed: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 6) Capability two (2026-09-20): the pin sync guard -- DSH/gateway pins may only come from the version
//          matrix src/dsh-matrix.ts; an installer/image/upgrade script/release archive that disagrees = CI red ----
try {
  const matrixSrc = readFileSync(join(root, 'src/dsh-matrix.ts'), 'utf8')
  const defaultDsh = /dsh: '([^']+)'/.exec(matrixSrc)?.[1] ?? ''
  const gatewayRef = /GATEWAY_REF = '([^']+)'/.exec(matrixSrc)?.[1] ?? ''
  const pinChecks = [
    ['install.ps1', /\$DSH_VERSION = '([^']+)'/, defaultDsh],
    ['images/node/gen-node-profile.mjs', /DSH_VERSION = process\.env\.DSH_VERSION \?\? '([^']+)'/, defaultDsh],
    ['images/node/gen-node-profile.mjs', /GATEWAY_REF = process\.env\.GATEWAY_REF \|\| GATEWAY_REF_BY_VERSION\[DSH_VERSION\] \|\| '([^']+)'/, gatewayRef],
    ['images/node/Dockerfile', /ARG DSH_VERSION=([^\s]+)/, defaultDsh],
    ['scripts/upgrade-node-version.mjs', /GATEWAY_REF = '([^']+)'/, gatewayRef],
    ['scripts/make-release.mjs', /nodeImage = process\.env\.DSH_NODE_IMAGE \?\? 'hellodac\/dac-node:([^']+)'/, defaultDsh],
    // The node-image TAG triangle (CI hit this the day the default flipped): compose builds the image
    // under the .env/fallback tag, provisioning asks docker for the matrix-default tag -- a mismatch
    // sends the worker on a Hub pull that does not exist. All three must equal the matrix default.
    ['docker-compose.yml', /DSH_NODE_IMAGE:-hellodac\/dac-node:([^}]+)\}/, defaultDsh],
    ['scripts/gen-env.sh', /ensure DSH_NODE_IMAGE "hellodac\/dac-node:([^"]+)"/, defaultDsh],
    ['manager.config.container.example.yaml', /image: hellodac\/dac-node:([^\s]+)/, defaultDsh],
  ]
  for (const [file, re, expected] of pinChecks) {
    const content = readFileSync(join(root, file), 'utf8')
    const match = re.exec(content)
    if (match === null) {
      failures.push(`${file}: no pin literal found (Capability two guard; sync this assertion when the format changes)`)
      continue
    }
    if (match[1] !== expected) {
      failures.push(`${file}: pin ${match[1]} disagrees with the version matrix (expected ${expected}) -- change it in src/dsh-matrix.ts only, never hand-edit several places`)
    }
  }
  // 0.2.0 corridor: the facade pin is PER VERSION -- a pre-corridor facade on a 0.2.0 host dies
  // silently (the answerer pump never iterates; question/approval cards hang forever, dsh-facts
  // §18.2). Every script that resolves a per-version ref must agree with the matrix rows, and the
  // Dockerfile must NOT hard-default GATEWAY_REF (an empty ARG lets the per-version resolution
  // win; a stale hard default would silently mispair a line with the wrong facade).
  if (!/ARG GATEWAY_REF=\s*$/m.test(readFileSync(join(root, 'images/node/Dockerfile'), 'utf8'))) {
    failures.push('images/node/Dockerfile: ARG GATEWAY_REF must default EMPTY (gen-node-profile.mjs resolves the paired ref per DSH_VERSION; a hard default mispairs the 0.2.0 line)')
  }
  const gatewayRefLegacy = /GATEWAY_REF_LEGACY = '([^']+)'/.exec(matrixSrc)?.[1] ?? ''
  const row020 = /\{ dsh: '0\.2\.0-rc\.2', gateway: GATEWAY_REF,/.test(matrixSrc)
  const legacyRows = (matrixSrc.match(/gateway: GATEWAY_REF_LEGACY/g) ?? []).length
  if (gatewayRef === '' || gatewayRefLegacy === '' || !row020 || legacyRows !== 2) {
    failures.push('src/dsh-matrix.ts: expected GATEWAY_REF (the 0.2.0 default-row ref), GATEWAY_REF_LEGACY (both 0.1.x rows) and the row wiring to be intact (per-version facade pin guard)')
  } else {
    const expectedByRow = { '0.2.0-rc.2': gatewayRef, '0.1.5-rc.2': gatewayRefLegacy, '0.1.2-rc.1': gatewayRefLegacy }
    for (const file of ['images/node/gen-node-profile.mjs', 'scripts/upgrade-node-version.mjs']) {
      const content = readFileSync(join(root, file), 'utf8')
      const mapBlock = /GATEWAY_REF_BY_VERSION = \{([\s\S]*?)\}/.exec(content)?.[1] ?? ''
      for (const [version, expected] of Object.entries(expectedByRow)) {
        const found = new RegExp(`'${version.replace(/\./g, '\\.')}':\\s*'([^']+)'`).exec(mapBlock)?.[1]
        if (found !== expected) {
          failures.push(`${file}: GATEWAY_REF_BY_VERSION['${version}'] is ${found ?? 'missing'} but the matrix pins ${expected} (a wrong pairing silently hangs the card chain on 0.2.0, dsh-facts §18.2)`)
        }
      }
    }
  }
  // 0.2.0 corridor: the legacy-line gate decides the settings.yaml-vs-patch key path, patchReload and
  // the privacy row -- a WRONG gate crash-loops 0.1.5 (§18.10: the prerelease dash never matches a
  // `0.1.5.*` pattern) or leaks session logs on 0.2.x (J1-22). The regex literal must be word-for-word
  // identical everywhere, and the bash entrypoint must cover the same spellings with its case arms.
  const gateLiteral = String.raw`/^0\.1\.(2|5)($|-|\.)/`
  for (const [file, needle] of [
    ['src/dsh-matrix.ts', gateLiteral],
    ['images/node/gen-node-profile.mjs', gateLiteral],
    ['public/assets/agent/runtime.mjs', gateLiteral],
    ['scripts/upgrade-node-version.mjs', gateLiteral],
  ]) {
    if (!readFileSync(join(root, file), 'utf8').includes(needle)) {
      failures.push(`${file}: missing the legacy-line gate ${needle} (the §18.10 prerelease-dash guard; keep it word-for-word in sync with isLegacyDshLine in src/dsh-matrix.ts)`)
    }
  }
  const entrypoint = readFileSync(join(root, 'images/node/entrypoint.sh'), 'utf8')
  for (const arm of ['0.1.2 | 0.1.2-*', '0.1.5 | 0.1.5-* | 0.1.5.*']) {
    if (!entrypoint.includes(arm)) {
      failures.push(`images/node/entrypoint.sh: the version case is missing the "${arm}" arms (the legacy lines must never take the patch-config key path, §18.10)`)
    }
  }
  if (!entrypoint.includes('cordis.patch.yml')) {
    failures.push('images/node/entrypoint.sh: missing the patch-config key injection for the new lines (J1-04: settings.yaml is a one-shot import on 0.1.7+/0.2.x)')
  }
  if (!entrypoint.includes('node_modules/@deepseek-ai/dsh/lib/bin.js')) {
    failures.push('images/node/entrypoint.sh: missing the profile-local-bin boot preference (a mixed-tree boot double-instances dsh-app-boot and breaks live settings writes on the new lines, dsh-facts §19.9)')
  }
  // The upgrade script's SUPPORTED table = the set of matrix rows (the dsh list + needsLegacyPeerDeps alignment) --
  // adding a matrix row/changing a flag while the script table lags = CI red.
  const upgradeSrc = readFileSync(join(root, 'scripts/upgrade-node-version.mjs'), 'utf8')
  const matrixDsh = [...matrixSrc.matchAll(/dsh: '([^']+)'/g)].map((m) => m[1])
  const matrixLegacy = [...matrixSrc.matchAll(/dsh: '([^']+)',[^\n]*needsLegacyPeerDeps: true/g)].map((m) => m[1])
  for (const v of matrixDsh) {
    if (!upgradeSrc.includes(`dsh: '${v}'`)) failures.push(`scripts/upgrade-node-version.mjs: the SUPPORTED table is missing matrix row ${v}`)
  }
  const scriptRows = [...upgradeSrc.matchAll(/\{ dsh: '([^']+)', legacyPeerDeps: (true|false) \}/g)]
  for (const v of matrixDsh) {
    const row = scriptRows.find((m) => m[1] === v)
    if (row === undefined) continue
    const wantsLegacy = matrixLegacy.includes(v)
    if ((row[2] === 'true') !== wantsLegacy) failures.push(`scripts/upgrade-node-version.mjs: row ${v} has legacyPeerDeps=${row[2]} which disagrees with the matrix needsLegacyPeerDeps=${wantsLegacy}`)
  }
  // The container build script's LEGACY_PEER_DEPS_VERSIONS = the set of matrix rows with needsLegacyPeerDeps --
  // building a 0.1.5 image without --legacy-peer-deps on the profile install is a guaranteed ERESOLVE (dsh-facts §12).
  const genProfileSrc = readFileSync(join(root, 'images/node/gen-node-profile.mjs'), 'utf8')
  const legacyListMatch = /const LEGACY_PEER_DEPS_VERSIONS = \[([^\]]*)\]/.exec(genProfileSrc)
  if (legacyListMatch === null) {
    failures.push('images/node/gen-node-profile.mjs: missing the LEGACY_PEER_DEPS_VERSIONS declaration (Capability two guard; sync this assertion when the format changes)')
  } else {
    const scriptLegacy = [...legacyListMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    for (const v of matrixLegacy) {
      if (!scriptLegacy.includes(v)) failures.push(`images/node/gen-node-profile.mjs: LEGACY_PEER_DEPS_VERSIONS is missing matrix row ${v}`)
    }
    for (const v of scriptLegacy) {
      if (!matrixLegacy.includes(v)) failures.push(`images/node/gen-node-profile.mjs: ${v} in LEGACY_PEER_DEPS_VERSIONS is not a needsLegacyPeerDeps row in the matrix`)
    }
  }
  // Move-and-repin guard (2026-09-20): every install.sh run must repin the host-side workspace path of
  // host_volumes to the real absolute path of the install directory (review B2 extension) -- it is the
  // precondition for converging by cd-ing in and rerunning install.sh after moving a directory; a deleted/
  // broken sed = CI red.
  const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
  if (!installSh.includes('APP_DIR_ABS}/workspaces')) {
    failures.push('install.sh: missing the host-side host_volumes path repin sed (move-and-repin guard)')
  }
  // node-agent's LEGACY_PEER_DEPS_VERSIONS = the set of matrix rows with needsLegacyPeerDeps
  // (the agent runs standalone and cannot import the TS matrix, so this guard keeps the two lists in sync).
  const agentRuntime = readFileSync(join(root, 'public/assets/agent/runtime.mjs'), 'utf8')
  const agentLegacyMatch = /LEGACY_PEER_DEPS_VERSIONS = \[([^\]]*)\]/.exec(agentRuntime)
  if (agentLegacyMatch === null) {
    failures.push('public/assets/agent/runtime.mjs: missing the LEGACY_PEER_DEPS_VERSIONS declaration (Capability four guard)')
  } else {
    const agentLegacy = [...agentLegacyMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    for (const v of matrixLegacy) {
      if (!agentLegacy.includes(v)) failures.push(`public/assets/agent/runtime.mjs: LEGACY_PEER_DEPS_VERSIONS is missing matrix row ${v}`)
    }
    for (const v of agentLegacy) {
      if (!matrixLegacy.includes(v)) failures.push(`public/assets/agent/runtime.mjs: ${v} in LEGACY_PEER_DEPS_VERSIONS is not a needsLegacyPeerDeps row in the matrix`)
    }
  }
  // Fleet M1 pilot Windows regression: npm must use shell:true (a .cmd shim; no shell = ENOENT/EINVAL),
  // and the install directory must go through cwd only (a path passed via --prefix gets split by the shell when it contains spaces).
  if (!/shell:\s*true/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: the npm call is missing shell:true (the Windows .cmd shim ENOENT regression point)')
  }
  if (/'--prefix'/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: npm install must not pass a path via --prefix (a path with spaces gets split by the shell; use cwd)')
  }
  if (!/spawnInvocation\s*=/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: missing spawnInvocation (spawning bin.js directly on win32 = EFTYPE, it must run through node)')
  }
  if (!/profileBin !== null && this\.fs\.exists\(profileBin\)/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: execSpawn does not prefer the profile-local bin (a prefix tree without legacy peers crashes on start -- proven in the M1 pilot)')
  }
  if (!/execDeliver/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: missing the config.deliver identity rotation handling (the landing end of the M4-1 rotation instruction)')
  }
  if (!/NODE_LOG_MAX_BYTES/.test(agentRuntime)) {
    failures.push('public/assets/agent/runtime.mjs: missing the NODE_LOG_MAX_BYTES rotation cap (the M4-2 log limit)')
  }
  // M4-3: the entry point depends on update.mjs -- both join installers must download it with the package; missing = a crash right after install
  const joinPs1 = readFileSync(join(root, 'scripts/join.ps1'), 'utf8')
  const joinSh = readFileSync(join(root, 'public/assets/agent/join.sh'), 'utf8')
  if (!joinPs1.includes('update.mjs')) failures.push('scripts/join.ps1: does not download update.mjs (an agent entry-point dependency; missing = a crash right after install)')
  if (!joinSh.includes('update.mjs')) failures.push('public/assets/agent/join.sh: does not download update.mjs (an agent entry-point dependency; missing = a crash right after install)')
  // Measured in M2: the DSH 0.1.5 launcher depends on import.meta.main and exits 0 silently below
  // the floor -- the join scripts need a real version gate (not just a check that node exists).
  // 0.2.0 corridor: the floor is 22.19 (the 0.2.x dsh family declares engines node >=22.19.0).
  if (!joinSh.includes('22.19')) failures.push('public/assets/agent/join.sh: missing the Node ≥22.19 version gate (import.meta.main silent exit + the 0.2.x engines floor)')
  if (!joinPs1.includes('22.19')) failures.push('scripts/join.ps1: missing the Node ≥22.19 version gate (import.meta.main silent exit + the 0.2.x engines floor)')
  // The precondition for dropping privileges on a public agent (2026-09-27, CONCEPTS-ALIGNED.md §4.5): the agent
  // starts nodes under **its own OS user**, so "a public agent is not root" can only be achieved by dropping the
  // agent's own privileges. No AGENT_USER support = a public agent can only run as root = it can read the
  // container data and root credentials on the same machine.
  if (!joinSh.includes('AGENT_USER')) failures.push('public/assets/agent/join.sh: missing AGENT_USER privilege-drop support (a public agent must be able to run non-root)')
  if (!joinSh.includes('User=$AGENT_USER')) failures.push('public/assets/agent/join.sh: the unit does not put AGENT_USER into User= (the privilege drop has no effect)')
  if (!joinSh.includes('WantedBy=multi-user.target')) {
    failures.push('public/assets/agent/join.sh: must install a system unit (WantedBy=multi-user.target) -- a user unit does not start without a login session, the 2026-09-25 whole-machine-blackout incident')
  }
  if (!joinSh.includes('ohdsh-agent')) {
    failures.push('public/assets/agent/join.sh: missing the old user unit cleanup (a leftover fights the system unit for the port)')
  }
  if (!/\/api\/agents\/:id\/rotate/.test(readFileSync(join(root, 'src/routes/agents.ts'), 'utf8'))) {
    failures.push('src/routes/agents.ts: missing the /api/agents/:id/rotate rotation endpoint (M4-1)')
  }
  // Proven in the M1 pilot (dsh-facts §14): the legacy install method of 0.1.5-rc.2 skips every peer ->
  // the explicit peer list (one in profile.ts, one in gen-node-profile.mjs) must match word for word;
  // and the PROFILE_LOCKS lock files must cover every needsLegacyPeerDeps row of the matrix.
  const profileSrc = readFileSync(join(root, 'src/host-node/profile.ts'), 'utf8')
  const pinPairs = (src, anchor) => {
    const block = new RegExp(`${anchor}[\\s\\S]*?= \\{([\\s\\S]*?)\\n\\}`, 'm').exec(src)
    return block === null ? null : new Map([...block[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))
  }
  const tsPins = pinPairs(profileSrc, 'LEGACY_PEER_PINS')
  const mjsPins = pinPairs(readFileSync(join(root, 'images/node/gen-node-profile.mjs'), 'utf8'), 'const LEGACY_PEER_PINS')
  const pinSetsEqual = (a, b) => a !== null && b !== null && a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
  if (tsPins === null) failures.push('src/host-node/profile.ts: missing the LEGACY_PEER_PINS declaration (the legacy peer top-up list)')
  if (mjsPins === null) failures.push('images/node/gen-node-profile.mjs: missing the LEGACY_PEER_PINS declaration (kept in sync with profile.ts)')
  if (!pinSetsEqual(tsPins, mjsPins)) failures.push('the LEGACY_PEER_PINS of profile.ts and gen-node-profile.mjs disagree (the two lists must stay word-for-word in sync)')
  if (!/patchReload:\s*'startup'/.test(profileSrc)) failures.push('src/host-node/profile.ts: the profile manifest does not pin patchReload startup (live watching depends hard on HMR; the legacy install method is a guaranteed crash)')
  const locksSrc = readFileSync(join(root, 'src/host-node/profile-locks.ts'), 'utf8')
  for (const v of matrixLegacy) {
    if (!new RegExp(`'${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':`).test(locksSrc)) failures.push(`src/host-node/profile-locks.ts: matrix legacy row ${v} has no lock file (the ^ range drift regression point)`)
  }
  if (!locksSrc.includes('node_modules/@deepseek-ai/cordis-plugin-group')) failures.push('src/host-node/profile-locks.ts: cordis-plugin-group is missing from the lock (an explicit peer that did not make it into the lock)')
  // Front-end import completeness canary (the 2026-09-22 incident): nodes.js used
  // versionOptionsHtml but missed the import -> the page hung on "loading" and no test could catch it
  // (a DOM file cannot be imported by a unit test). At least keep this one known regression point.
  const nodesJs = readFileSync(join(root, 'public/assets/nodes.js'), 'utf8')
  if (nodesJs.includes('versionOptionsHtml(') && !nodesJs.includes('versionOptionsHtml }')) {
    failures.push('public/assets/nodes.js: uses versionOptionsHtml without importing it (front-end ReferenceError regression point)')
  }
  if (nodesJs.includes('${guiBits}') && !nodesJs.includes('const guiBits')) {
    failures.push('public/assets/nodes.js: nodeRow references guiBits without a definition (front-end ReferenceError regression point)')
  }
  // Fleet M3-1: the three-piece guard for the third ops sandbox tier (the schema tier / the wizard option / the yellow-text confirmation)
  const nodesHtml = readFileSync(join(root, 'public/pages/nodes.html'), 'utf8')
  if (!nodesHtml.includes('value="danger-full-access"')) {
    failures.push('public/pages/nodes.html: the wizard sandbox dropdown is missing the danger-full-access tier (M3-1 ops nodes)')
  }
  if (!/danger-full-access/.test(readFileSync(join(root, 'src/routes/provision.ts'), 'utf8'))) {
    failures.push('src/routes/provision.ts: the provisionBody sandbox schema is missing the danger-full-access tier')
  }
  // P0 config migration chain guard (hive/plan-config-version-switch): CONFIG_MIGRATIONS must cover the
  // contiguous +1 upgrade chain 0..CURRENT_CONFIG_VERSION -- the precondition for automatic migration on
  // upgrade; a deleted/broken chain = CI red.
  const migrationsSrc = readFileSync(join(root, 'src/config/migrations.ts'), 'utf8')
  const currentMatch = /CURRENT_CONFIG_VERSION = (\d+)/.exec(migrationsSrc)
  if (currentMatch === null) {
    failures.push('src/config/migrations.ts: missing the CURRENT_CONFIG_VERSION declaration (the config migration chain guard)')
  } else {
    const current = Number(currentMatch[1])
    const steps = [...migrationsSrc.matchAll(/\{ from: (\d+), to: (\d+),/g)]
    const covered = new Set(steps.map((m) => m[1]))
    for (let v = 0; v < current; v += 1) {
      if (!covered.has(String(v))) failures.push(`src/config/migrations.ts: the migration chain is missing ${v} → ${v + 1} (CURRENT_CONFIG_VERSION=${current})`)
    }
    for (const m of steps) {
      if (Number(m[2]) !== Number(m[1]) + 1) failures.push(`src/config/migrations.ts: the migration {from:${m[1]},to:${m[2]}} must be a +1 upgrade chain`)
      if (Number(m[1]) >= current) failures.push(`src/config/migrations.ts: the migration {from:${m[1]},to:${m[2]}} starts outside the 0..${current - 1} range`)
    }
  }

  // Consistency guard for the CSRF cookie name (built for renames): compose-e2e hard-codes this cookie
  // name in the login flow, so renaming it in the source without following up in the script breaks the
  // compose-e2e login step in CI, and the symptom (401/no CSRF) sits a long way from the real cause.
  const csrfName = /export const CSRF_COOKIE = '([^']+)'/.exec(readFileSync(join(root, 'src/routes/auth.ts'), 'utf8'))?.[1]
  if (csrfName === undefined) {
    failures.push('src/routes/auth.ts: missing the CSRF_COOKIE declaration (compose-e2e depends on it)')
  } else if (!readFileSync(join(root, 'scripts/compose-e2e.mjs'), 'utf8').includes(`startsWith('${csrfName}=')`)) {
    failures.push(`scripts/compose-e2e.mjs: the CSRF cookie name disagrees with that constant (${csrfName}) -- compose-e2e will fail at the login step`)
  }
} catch (error) {
  failures.push(`pin sync guard failed: ${error instanceof Error ? error.message : String(error)}`)
}

if (failures.length > 0) {
  console.error('check-docs FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('check-docs: OK (README has no dead links and no hand-written test counts, deployment files are complete, the pins match the matrix)')
