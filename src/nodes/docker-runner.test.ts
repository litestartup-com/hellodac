import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Dockerode from 'dockerode'
import { DockerRunner } from './docker-runner.js'
import type { ResolvedSpawnSpec } from '../config.js'

/** A docker multiplexed frame: an 8-byte header (1 byte stream type + 3 padding + 4-byte big-endian length) + payload. */
const frame = (type: number, payload: string): Buffer => {
  const body = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = type
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

/** The fake dockerode used in tests: it implements only what DockerRunner touches and records every call. */
const fake = (options: { imageExists?: boolean; leftovers?: Array<{ Id: string }>; inspectThrows?: boolean; inspectImage?: string } = {}) => {
  const state = {
    pulls: [] as string[],
    created: [] as Array<Record<string, unknown>>,
    started: [] as string[],
    stopped: [] as string[],
    removed: [] as string[],
    listed: 0,
    logRequests: [] as string[],
  }
  const docker = {
    getImage: (image: string) => ({
      inspect: async () => {
        if (options.imageExists !== true) throw new Error(`no such image: ${image}`)
        return {}
      },
    }),
    pull: (image: string, cb: (error: Error | null, stream?: unknown) => void) => {
      state.pulls.push(image)
      cb(null, {})
    },
    modem: { followProgress: (_stream: unknown, onFinished: () => void) => onFinished() },
    listContainers: async () => {
      state.listed += 1
      return options.leftovers ?? []
    },
    createContainer: async (params: Record<string, unknown>) => {
      state.created.push(params)
      return {
        id: 'container-1',
        start: async () => {
          state.started.push('container-1')
        },
      }
    },
    getContainer: (id: string) => ({
      stop: async () => {
        state.stopped.push(id)
      },
      remove: async () => {
        state.removed.push(id)
      },
      logs: async () => {
        state.logRequests.push(id)
        return Buffer.from(`logs-of-${id}\n`)
      },
      inspect: async () => {
        if (options.inspectThrows === true) throw new Error('no such container')
        return { Config: { Image: options.inspectImage ?? 'hellodac/dac-node:0.1.2-rc.1' } }
      },
    }),
  }
  return { state, docker: docker as unknown as Dockerode }
}

const dockerSpec = (): ResolvedSpawnSpec => ({
  managed: true,
  command: '',
  args: [],
  cwd: null,
  readyTimeoutMs: 30_000,
  detached: false,
  logFile: null,
  env: {},
  restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  runner: 'docker',
  host: null,
  docker: {
    image: 'hellodac/dac-node:0.1.1-rc.2',
    containerName: null,
    network: 'hive',
    port: 3081,
    hostVolumes: { '/opt/dac/workspaces/personal': '/workspace' },
    namedVolumes: { 'dac-personal': '/data' },
  },
})

test('Hive plan 2 P2b: ensureImage pulls only when missing; when present, no network at all', async () => {
  const missing = fake()
  await new DockerRunner({ docker: missing.docker }).ensureImage('img')
  assert.deepEqual(missing.state.pulls, ['img'])

  const present = fake({ imageExists: true })
  await new DockerRunner({ docker: present.docker }).ensureImage('img')
  assert.deepEqual(present.state.pulls, [])
})

test('Hive plan 2 P2b: start creates the container (name/labels/command/env/mounts) and clears a same-name leftover first', async () => {
  const f = fake({ leftovers: [{ Id: 'stale-1' }] })
  const runner = new DockerRunner({ docker: f.docker })
  const id = await runner.start(dockerSpec(), 'personal', { DSH_HOME: '/data', GW_KEY: 'apigw-x' })
  assert.equal(id, 'container-1')
  assert.deepEqual(f.state.removed, ['stale-1'], 'the same-name leftover container is force-cleared')
  const created = f.state.created[0]
  assert.ok(created !== undefined)
  assert.equal(created.name, 'dac-node-personal')
  assert.equal(created.Image, 'hellodac/dac-node:0.1.1-rc.2')
  assert.deepEqual(created.Cmd, ['--port', '3081', '--trusted-host', 'node-personal', 'node-personal:3081'])
  assert.deepEqual(created.Labels, { 'com.dac.managed': 'true', 'com.dac.node': 'personal' })
  assert.deepEqual(created.Env, ['DSH_HOME=/data', 'GW_KEY=apigw-x'])
  const host = created.HostConfig as { NetworkMode: string; Binds: string[]; RestartPolicy: { Name: string }; PortBindings?: Record<string, unknown> }
  assert.equal(host.NetworkMode, 'hive')
  assert.deepEqual(host.Binds, ['/opt/dac/workspaces/personal:/workspace', 'dac-personal:/data'])
  assert.deepEqual(host.RestartPolicy, { Name: 'unless-stopped' })
  // Capability three v1: the node GUI port is published to the host loopback only (the SSH tunnel target; never public)
  assert.deepEqual(host.PortBindings, { '3081/tcp': [{ HostIp: '127.0.0.1', HostPort: '3081' }] }, 'the GUI port must bind 127.0.0.1 only')
  // Network alias: the manager's probe URL http://node-<id>:port resolves through it (regression for the fetch-failed root cause)
  const net = created.NetworkingConfig as { EndpointsConfig: Record<string, { Aliases: string[] }> }
  assert.deepEqual(net.EndpointsConfig['hive']?.Aliases, ['node-personal', 'personal'])
  // Same uid as the host deployment user (write access to the workspace bind mount)
  assert.match(String(created.User ?? ''), /^\d+:\d+$/)
})

test('Hive plan 2 P2b: stop = stop + remove; logs collects the container output', async () => {
  const f = fake()
  const runner = new DockerRunner({ docker: f.docker })
  await runner.stop('cid-9')
  assert.deepEqual(f.state.stopped, ['cid-9'])
  assert.deepEqual(f.state.removed, ['cid-9'])
  assert.equal(await runner.logs('cid-9', 100), 'logs-of-cid-9\n')
})

test('Node version display: containerImage returns the container image tag, null when it is gone', async () => {
  const f = fake()
  const runner = new DockerRunner({ docker: f.docker })
  assert.equal(await runner.containerImage('cid-1'), 'hellodac/dac-node:0.1.2-rc.1')
  const gone = fake({ inspectThrows: true })
  const goneRunner = new DockerRunner({ docker: gone.docker })
  assert.equal(await goneRunner.containerImage('cid-missing'), null, 'a vanished container counts as unknown')
})

test('Hive plan 2 P2b: listManaged returns only managed-labelled containers with normalised fields', async () => {
  const listed = [
    { Id: 'abc', Names: ['/dac-node-personal'], Labels: { 'com.dac.managed': 'true', 'com.dac.node': 'personal' }, State: 'running' },
    { Id: 'def', Names: ['/dac-node-product'], Labels: { 'com.dac.managed': 'true', 'com.dac.node': 'product' }, State: 'exited' },
  ]
  const f = fake()
  const original = (f.docker as unknown as { listContainers: () => Promise<unknown> }).listContainers
  ;(f.docker as unknown as { listContainers: () => Promise<unknown> }).listContainers = async () => listed
  const runner = new DockerRunner({ docker: f.docker })
  const result = await runner.listManaged()
  assert.deepEqual(result, [
    { id: 'abc', name: 'dac-node-personal', labels: { 'com.dac.managed': 'true', 'com.dac.node': 'personal' }, state: 'running' },
    { id: 'def', name: 'dac-node-product', labels: { 'com.dac.managed': 'true', 'com.dac.node': 'product' }, state: 'exited' },
  ])
  void original
})

test('Hive plan 2 P6 regression: matchesSpec -- a GW_KEY or image-ID mismatch must rebuild, not adopt', () => {
  const good = { env: ['GW_KEY=apigw-new', 'DSH_HOME=/data'], imageId: 'sha256:abc' }
  assert.equal(DockerRunner.matchesSpec(good, 'apigw-new', 'sha256:abc'), true, 'key and image ID agree -> adoptable')
  assert.equal(DockerRunner.matchesSpec(good, 'apigw-other', 'sha256:abc'), false, 'an old key -> rebuild (the reinstall-leftover root cause)')
  assert.equal(DockerRunner.matchesSpec({ env: ['GW_KEY=apigw-new'], imageId: 'sha256:old' }, 'apigw-new', 'sha256:abc'), false, 'same tag but a new image ID -> rebuild')
  assert.equal(DockerRunner.matchesSpec({ env: ['GW_KEY=apigw-new'], imageId: 'sha256:abc' }, '', 'sha256:abc'), false, 'no key on the manager side but a keyed container -> rebuild')
  assert.equal(DockerRunner.matchesSpec({ env: ['GW_KEY=apigw-new'], imageId: 'sha256:abc' }, 'apigw-new', null), true, 'with no expected image ID, skip the image check (key only)')
})

/** The fake dockerode for the runToolIo tests: attach returns a multiplexed frame stream (stdout/stderr/exit code injectable). */
const fakeToolDocker = (scenario: { exitCode: number; frames?: Array<{ type: number; payload: string }> }) => {
  const state = {
    created: [] as Array<Record<string, unknown>>,
    removed: 0,
    attachOptions: null as null | Record<string, unknown>,
    stdinWritten: [] as Buffer[],
  }
  const demux = (stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void => {
    let buf = Buffer.alloc(0)
    stream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 8) break
        const len = buf.readUInt32BE(4)
        if (buf.length < 8 + len) break
        const type = buf[0]
        const payload = buf.subarray(8, 8 + len)
        buf = buf.subarray(8 + len)
        if (type === 1) stdout.write(payload)
        else if (type === 2) stderr.write(payload)
      }
    })
    stream.on('end', () => {
      stdout.end()
      stderr.end()
    })
  }
  const docker = {
    getImage: () => ({ inspect: async () => ({}) }),
    modem: { demuxStream: demux, followProgress: (_s: unknown, done: () => void) => done() },
    createContainer: async (params: Record<string, unknown>) => {
      state.created.push(params)
      return {
        start: async () => {},
        attach: async (opts: Record<string, unknown>) => {
          state.attachOptions = opts
          const stream = new PassThrough()
          const originalWrite = stream.write.bind(stream)
          stream.write = ((chunk: Buffer) => {
            state.stdinWritten.push(Buffer.from(chunk))
            return originalWrite(chunk)
          }) as typeof stream.write
          setImmediate(() => {
            const frames = scenario.frames ?? []
            if (frames.length > 0) {
              for (const f of frames) stream.write(frame(f.type, f.payload))
              stream.end()
            }
            // No frames = the stdin-only case: the stream stays open and the pipeline ends it (same as a real attach stream)
          })
          return stream
        },
        wait: async () => ({ StatusCode: scenario.exitCode }),
        remove: async () => {
          state.removed += 1
        },
      }
    },
  }
  return { state, docker: docker as unknown as Dockerode }
}

test('Debt R10 regression: runToolIo streams over attach -- stdout lands in a file (no backup-dir bind; the host path is unknown)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runToolIo-'))
  try {
    const f = fakeToolDocker({ exitCode: 0, frames: [{ type: 1, payload: 'tar-bytes-here' }] })
    const outFile = join(root, 'node.tar.gz')
    await new DockerRunner({ docker: f.docker }).runToolIo(
      'alpine:3.20',
      ['tar', 'czf', '-', '-C', '/data', '.'],
      [{ from: 'dac-personal', to: '/data' }],
      { stdout: outFile },
    )
    assert.equal(readFileSync(outFile, 'utf8'), 'tar-bytes-here', 'the stdout frames must land in the file intact')
    const created = f.state.created[0] as { HostConfig: { Binds: string[] }; AttachStdout: boolean; AttachStdin: boolean | undefined }
    assert.deepEqual(created.HostConfig.Binds, ['dac-personal:/data'], 'volume bind only -- the backup dir is no longer bound as a host path (the ENOENT root cause)')
    assert.equal(created.AttachStdout, true)
    assert.notEqual(created.AttachStdin, true, 'stdin is not attached when there is none')
    assert.equal(f.state.removed, 1, 'the tool container is removed as soon as it is done')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Debt R10 regression: runToolIo throws on a non-zero exit code and carries stderr', async () => {
  const f = fakeToolDocker({ exitCode: 1, frames: [{ type: 2, payload: 'tar: error reading /data\n' }] })
  await assert.rejects(
    () => new DockerRunner({ docker: f.docker }).runToolIo('alpine:3.20', ['tar', 'czf', '-', '-C', '/data', '.'], [], {}),
    /exited with code 1.*tar: error reading \/data/s,
  )
  assert.equal(f.state.removed, 1)
})

test('Debt R10 regression: runToolIo feeds stdin from a file into the tool container (the restore reverse flow)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runToolIo-stdin-'))
  try {
    const f = fakeToolDocker({ exitCode: 0 })
    const inFile = join(root, 'in.tar.gz')
    writeFileSync(inFile, 'tarball-bytes', 'utf8')
    await new DockerRunner({ docker: f.docker }).runToolIo(
      'alpine:3.20',
      ['tar', 'xzf', '-', '-C', '/data'],
      [{ from: 'dac-personal', to: '/data' }],
      { stdin: inFile },
    )
    assert.equal(Buffer.concat(f.state.stdinWritten).toString('utf8'), 'tarball-bytes', 'stdin must be fed into the attach stream verbatim')
    const created = f.state.created[0] as { AttachStdin: boolean | undefined }
    assert.equal(created.AttachStdin, true)
    assert.equal(f.state.removed, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
