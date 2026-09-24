import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Dockerode from 'dockerode'
import { DockerRunner } from './docker-runner.js'
import type { ResolvedSpawnSpec } from '../config.js'

/** docker 多路复用帧：8 字节头（1 字节流类型 + 3 空 + 4 字节大端长度）+ payload。 */
const frame = (type: number, payload: string): Buffer => {
  const body = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = type
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

/** 测试用假 dockerode：只实现 DockerRunner 用到的面，调用全部留痕。 */
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

test('蜂群2计划 P2b: ensureImage 缺失才拉，存在零网络', async () => {
  const missing = fake()
  await new DockerRunner({ docker: missing.docker }).ensureImage('img')
  assert.deepEqual(missing.state.pulls, ['img'])

  const present = fake({ imageExists: true })
  await new DockerRunner({ docker: present.docker }).ensureImage('img')
  assert.deepEqual(present.state.pulls, [])
})

test('蜂群2计划 P2b: start 创建容器（名称/标签/命令/环境/挂载），同名残留先清', async () => {
  const f = fake({ leftovers: [{ Id: 'stale-1' }] })
  const runner = new DockerRunner({ docker: f.docker })
  const id = await runner.start(dockerSpec(), 'personal', { DSH_HOME: '/data', GW_KEY: 'apigw-x' })
  assert.equal(id, 'container-1')
  assert.deepEqual(f.state.removed, ['stale-1'], '同名残留容器被强制清理')
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
  // 能力三 v1：节点 GUI 端口只发布到宿主机 loopback（SSH 隧道目标；绝不进公网面）
  assert.deepEqual(host.PortBindings, { '3081/tcp': [{ HostIp: '127.0.0.1', HostPort: '3081' }] }, 'GUI 端口必须只绑 127.0.0.1')
  // 网络别名：manager 探活 URL http://node-<id>:port 靠它解析（fetch failed 根因回归）
  const net = created.NetworkingConfig as { EndpointsConfig: Record<string, { Aliases: string[] }> }
  assert.deepEqual(net.EndpointsConfig['hive']?.Aliases, ['node-personal', 'personal'])
  // 与宿主机部署用户同 uid（工作区 bind mount 写权限）
  assert.match(String(created.User ?? ''), /^\d+:\d+$/)
})

test('蜂群2计划 P2b: stop = stop + remove；logs 收集容器输出', async () => {
  const f = fake()
  const runner = new DockerRunner({ docker: f.docker })
  await runner.stop('cid-9')
  assert.deepEqual(f.state.stopped, ['cid-9'])
  assert.deepEqual(f.state.removed, ['cid-9'])
  assert.equal(await runner.logs('cid-9', 100), 'logs-of-cid-9\n')
})

test('节点版本展示: containerImage 返回容器的镜像标签，查不到返回 null', async () => {
  const f = fake()
  const runner = new DockerRunner({ docker: f.docker })
  assert.equal(await runner.containerImage('cid-1'), 'hellodac/dac-node:0.1.2-rc.1')
  const gone = fake({ inspectThrows: true })
  const goneRunner = new DockerRunner({ docker: gone.docker })
  assert.equal(await goneRunner.containerImage('cid-missing'), null, '容器已消失按未知处理')
})

test('蜂群2计划 P2b: listManaged 只回 managed 标签容器并归一化字段', async () => {
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

test('蜂群2计划 P6 回归: matchesSpec——GW_KEY 或镜像 ID 不符必须重建而非认领', () => {
  const good = { env: ['GW_KEY=apigw-new', 'DSH_HOME=/data'], imageId: 'sha256:abc' }
  assert.equal(DockerRunner.matchesSpec(good, 'apigw-new', 'sha256:abc'), true, '钥匙与镜像 ID 一致 → 可认领')
  assert.equal(DockerRunner.matchesSpec(good, 'apigw-other', 'sha256:abc'), false, '旧钥匙 → 重建（重装残留根因）')
  assert.equal(DockerRunner.matchesSpec({ env: ['GW_KEY=apigw-new'], imageId: 'sha256:old' }, 'apigw-new', 'sha256:abc'), false, 'tag 同名但镜像 ID 变了 → 重建')
  assert.equal(DockerRunner.matchesSpec({ env: ['GW_KEY=apigw-new'], imageId: 'sha256:abc' }, '', 'sha256:abc'), false, 'manager 侧无钥匙却认领有钥匙容器 → 重建')
  assert.equal(DockerRunner.matchesSpec({ env: ['GW_KEY=apigw-new'], imageId: 'sha256:abc' }, 'apigw-new', null), true, '拿不到期望镜像 ID 时跳过镜像比对（只比钥匙）')
})

/** runToolIo 测试专用假 dockerode：attach 返回多路复用帧流（可注入 stdout/stderr/退出码）。 */
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
            // 无帧 = 纯 stdin 场景：流保持打开，由 pipeline 收尾（真实 attach 流同语义）
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

test('债务 R10 回归: runToolIo 经 attach 流式传输——stdout 落文件（不 bind 备份目录，宿主路径不可知）', async () => {
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
    assert.equal(readFileSync(outFile, 'utf8'), 'tar-bytes-here', 'stdout 帧必须完整落到文件')
    const created = f.state.created[0] as { HostConfig: { Binds: string[] }; AttachStdout: boolean; AttachStdin: boolean | undefined }
    assert.deepEqual(created.HostConfig.Binds, ['dac-personal:/data'], '只绑卷——备份目录不再作为宿主路径 bind（ENOENT 根因）')
    assert.equal(created.AttachStdout, true)
    assert.notEqual(created.AttachStdin, true, '无 stdin 时不挂 stdin')
    assert.equal(f.state.removed, 1, '工具容器用完即删')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('债务 R10 回归: runToolIo 退出码非 0 抛错并带 stderr', async () => {
  const f = fakeToolDocker({ exitCode: 1, frames: [{ type: 2, payload: 'tar: error reading /data\n' }] })
  await assert.rejects(
    () => new DockerRunner({ docker: f.docker }).runToolIo('alpine:3.20', ['tar', 'czf', '-', '-C', '/data', '.'], [], {}),
    /exited with code 1.*tar: error reading \/data/s,
  )
  assert.equal(f.state.removed, 1)
})

test('债务 R10 回归: runToolIo stdin 从文件喂给工具容器（restore 反向流）', async () => {
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
    assert.equal(Buffer.concat(f.state.stdinWritten).toString('utf8'), 'tarball-bytes', 'stdin 必须原样喂进 attach 流')
    const created = f.state.created[0] as { AttachStdin: boolean | undefined }
    assert.equal(created.AttachStdin, true)
    assert.equal(f.state.removed, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
