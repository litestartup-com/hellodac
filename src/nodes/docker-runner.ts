/**
 * DockerRunner — 蜂群2计划 P2b：manager 经 docker.sock 管理本机节点容器。
 *
 * 一个 DSH 节点容器 = 镜像（构建期冻结依赖）+ 命名卷（节点 home）+ bind mount
 * （工作区）。所有容器打 `com.dac.managed=true` 标签：manager 只碰自己拉的
 * 容器，对账（认领在跑 / 补拉缺失）也以标签为界。
 *
 * 构造函数可注入 docker 实例（测试用假实现），生产走 /var/run/docker.sock。
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Dockerode from 'dockerode'
import type { ResolvedSpawnSpec } from '../config.js'

export const MANAGED_LABEL = 'com.dac.managed'
export const NODE_LABEL = 'com.dac.node'

export interface ManagedContainerInfo {
  id: string
  name: string
  labels: Record<string, string>
  state: 'running' | 'exited' | 'other'
}

export class DockerRunner {
  private readonly docker: Dockerode

  constructor(options: { socketPath?: string; docker?: Dockerode } = {}) {
    this.docker = options.docker ?? new Dockerode({ socketPath: options.socketPath ?? '/var/run/docker.sock' })
  }

  /** 镜像不存在才拉取；已存在 = 零网络。 */
  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect()
      return
    } catch {
      // 镜像缺失 → 拉取
    }
    await new Promise<void>((resolvePull, rejectPull) => {
      // 回调式调用，dockerode 同时返回一个 promise：显式丢弃，否则它的拒绝会
      // 变成未处理拒绝（错误本身已经由回调转给 rejectPull）。
      void this.docker.pull(image, (error: Error | null, stream?: NodeJS.ReadableStream) => {
        if (error !== null || stream === undefined) {
          rejectPull(error ?? new Error(`pull ${image}: no stream`))
          return
        }
        this.docker.modem.followProgress(stream, () => resolvePull(), () => undefined)
      })
    })
  }

  /**
   * 容器当前使用的镜像标签（Config.Image，即启动时传入的镜像名含 tag）。
   * 查不到/容器已消失返回 null——调用方按「未知」展示。
   */
  async containerImage(id: string): Promise<string | null> {
    try {
      const info = await this.docker.getContainer(id).inspect()
      return typeof info.Config?.Image === 'string' && info.Config.Image !== '' ? info.Config.Image : null
    } catch {
      return null
    }
  }

  /**
   * 创建并启动节点容器，返回容器 id。
   * 同名残留容器先强制清掉（重启/重建场景幂等）。
   */
  async start(spec: ResolvedSpawnSpec, nodeId: string, env: Record<string, string>): Promise<string> {
    const d = spec.docker
    if (d === null) throw new Error('a docker runner needs a docker section')
    const name = d.containerName ?? `dac-node-${nodeId}`

    const leftovers = await this.docker.listContainers({ all: true, filters: { name: [name] } }).catch(() => [])
    for (const c of leftovers) {
      await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined)
    }

    const container = await this.docker.createContainer({
      name,
      Image: d.image,
      // 与宿主机部署用户同 uid（HOST_UID 由 install.sh 写入 .env，经 env_file 进 manager）
      User: `${process.env.HOST_UID ?? '1000'}:${process.env.HOST_GID ?? '1000'}`,
      // 端口参数由 entrypoint 透传给 web app；容器内网访问，不发布到宿主机。
      // --trusted-host：/api 浏览器信任栅栏——manager 以 node-<id>:port 的 Host 访问，
      // 不在默认回环信任名单会 403 forbidden（容器实测）。
      Cmd: ['--port', String(d.port), '--trusted-host', `node-${nodeId}`, `node-${nodeId}:${String(d.port)}`],
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      Labels: { [MANAGED_LABEL]: 'true', [NODE_LABEL]: nodeId },
      WorkingDir: '/workspace',
      HostConfig: {
        NetworkMode: d.network,
        // 能力三 v1：节点 GUI 端口只发布到宿主机 loopback——SSH 隧道的目标
        // （浏览器经用户侧 ssh -L 打到 127.0.0.1:<port>）；绝不进公网面。
        PortBindings: {
          [`${d.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(d.port) }],
        },
        Binds: [
          ...Object.entries(d.hostVolumes).map(([host, containerPath]) => `${host}:${containerPath}`),
          ...Object.entries(d.namedVolumes).map(([volume, containerPath]) => `${volume}:${containerPath}`),
        ],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      // 蜂群2计划 P6 实测根因：manager 探活 URL 是 http://node-<id>:port，但 compose 的
      // 内嵌 DNS 只认识 compose 服务名——manager 自己拉的容器必须显式注册网络别名，
      // 否则 DNS 解析失败（fetch failed）。别名给两个形态：node-<id> 与 <id>。
      NetworkingConfig: {
        EndpointsConfig: {
          [d.network]: { Aliases: [`node-${nodeId}`, nodeId] },
        },
      },
    })
    await container.start()
    return container.id
  }

  /** 停止并删除容器（停止 = 删除：状态都在卷里，容器本身无状态）。 */
  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId)
    await container.stop({ t: 5 }).catch(() => undefined)
    await container.remove({ force: true }).catch(() => undefined)
  }

  /** 容器日志（尾部 tail 行）。promise 形态返回 Buffer（dockerode 契约）。 */
  async logs(containerId: string, tail: number): Promise<string> {
    const output = await this.docker.getContainer(containerId).logs({ stdout: true, stderr: true, tail, timestamps: false })
    return Buffer.isBuffer(output) ? output.toString('utf8') : String(output)
  }

  /** 本机所有 manager 管理的节点容器（对账以标签为界）。 */
  async listManaged(): Promise<ManagedContainerInfo[]> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } })
    return list.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? c.Id).replace(/^\//, ''),
      labels: c.Labels ?? {},
      state: c.State === 'running' ? 'running' : c.State === 'exited' ? 'exited' : 'other',
    }))
  }

  /** 容器运行时事实（env 与镜像 ID），用于对账时判断「在跑容器」是否还匹配当前配置。 */
  async runtimeFacts(containerId: string): Promise<{ env: string[]; imageId: string } | null> {
    try {
      const info = await this.docker.getContainer(containerId).inspect()
      return { env: info.Config.Env ?? [], imageId: info.Image }
    } catch {
      return null
    }
  }

  /** 当前 tag 对应的镜像 ID（tag 被重建覆盖后 ID 会变——比 tag 名更硬的判断依据）。 */
  async imageIdOf(image: string): Promise<string | null> {
    try {
      const info = await this.docker.getImage(image).inspect()
      return info.Id
    } catch {
      return null
    }
  }

  /**
   * 工蜂容器与当前期望是否一致（蜂群2计划 P6 实测根因：重装后旧容器带旧 GW_KEY
   * 被对账认领 → sandbox 401；以及 tag 同名重建后旧镜像容器不被发现 → 新入口
   * 不生效）。比对：GW_KEY 环境值 + 镜像 ID（不是 tag 名）。
   */
  static matchesSpec(facts: { env: string[]; imageId: string }, sandboxKey: string, expectedImageId: string | null): boolean {
    if (expectedImageId !== null && facts.imageId !== expectedImageId) return false
    const gwEntry = facts.env.find((e) => e.startsWith('GW_KEY='))
    if (sandboxKey === '') return gwEntry === undefined || gwEntry === 'GW_KEY='
    return gwEntry === `GW_KEY=${sandboxKey}`
  }

  /**
   * 蜂群2计划 P4：跑一个一次性工具容器（节点 home 卷的备份/恢复用），
   * stdin/stdout 经 attach 流式对接（stdin=读文件喂给容器，stdout=收流落文件）。
   *
   * 债务 R10 实证根因：旧实现把「备份目录」也做成 bind——但 manager 容器里的
   * /app/data/backups 是 bind mount 的容器视角路径，dockerd 按宿主机语义解析后
   * 指向宿主机上不存在的目录，tar 产物写进幽灵目录、manager 读不到（ENOENT）。
   * 流式传输不依赖「宿主路径 = 容器路径」的假设：只绑命名卷，数据走 stdin/stdout。
   */
  async runToolIo(
    image: string,
    cmd: string[],
    binds: Array<{ from: string; to: string }>,
    io: { stdin?: string; stdout?: string } = {},
  ): Promise<void> {
    await this.ensureImage(image)
    const container = await this.docker.createContainer({
      Image: image,
      Cmd: cmd,
      HostConfig: {
        Binds: binds.map((b) => `${b.from}:${b.to}`),
      },
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: io.stdin !== undefined,
      OpenStdin: io.stdin !== undefined,
      StdinOnce: io.stdin !== undefined,
    })
    await container.start()
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true, stdin: io.stdin !== undefined })
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      this.docker.modem.demuxStream(stream, stdout, stderr)
      let stderrText = ''
      stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8')
      })
      const stdoutDone = (async () => {
        if (io.stdout === undefined) {
          stdout.resume()
          return
        }
        await new Promise<void>((resolve, reject) => {
          const out = createWriteStream(io.stdout as string)
          out.on('error', reject)
          out.on('finish', resolve)
          stdout.pipe(out)
        })
      })()
      // stdin 经 pipeline 喂给 attach 流（文件读完 = EOF；容器先挂 EPIPE 属正常，
      // 退出码兜底报错）。无 stdin 时 AttachStdin:false，守护进程侧已关 stdin。
      const stdinDone =
        io.stdin === undefined
          ? Promise.resolve()
          : pipeline(createReadStream(io.stdin), stream).catch(() => undefined)
      // 等 attach 流关闭（stdout/stderr 全部送达）再判退出码——错误信息才带得全 stderr。
      const streamDone = new Promise<void>((resolve) => {
        stream.on('end', resolve)
        stream.on('close', resolve)
        stream.on('error', resolve)
      })
      const waited = await container.wait()
      await Promise.all([streamDone, stdoutDone, stdinDone])
      if (waited.StatusCode !== 0) {
        throw new Error(
          `tool container exited with code ${String(waited.StatusCode)}: ${cmd.join(' ')}${stderrText.trim() === '' ? '' : `\n${stderrText.trim()}`}`,
        )
      }
    } finally {
      await container.remove({ force: true }).catch(() => undefined)
    }
  }
}
