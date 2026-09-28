/**
 * DockerRunner — Hive plan 2 P2b: the manager manages local node containers over docker.sock.
 *
 * One DSH node container = an image (dependencies frozen at build time) + a named volume (the node home) + a bind
 * mount (the workspace). Every container carries the `com.dac.managed=true` label: the manager only touches
 * containers it pulled itself, and reconciliation (claiming the running ones / pulling the missing ones) is bounded by that label too.
 *
 * The constructor accepts an injected docker instance (tests use a fake); production goes through /var/run/docker.sock.
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

  /** Pull only when the image is missing; already present = zero network. */
  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect()
      return
    } catch {
      // The image is missing -> pull it
    }
    await new Promise<void>((resolvePull, rejectPull) => {
      // A callback-style call, and dockerode returns a promise at the same time: discard it explicitly, or its
      // rejection becomes an unhandled rejection (the error itself is already handed to rejectPull by the callback).
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
   * The image tag the container is currently using (Config.Image, i.e. the image name with tag passed at start).
   * Not found / the container is gone returns null -- the caller displays it as "unknown".
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
   * Create and start a node container, returning the container id.
   * A leftover container with the same name is force-removed first (idempotent across restarts/rebuilds).
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
      // The same uid as the host's deployment user (HOST_UID is written into .env by install.sh and reaches the manager through env_file)
      User: `${process.env.HOST_UID ?? '1000'}:${process.env.HOST_GID ?? '1000'}`,
      // The port argument is passed through to the web app by the entrypoint; access is over the container network, not published to the host.
      // --trusted-host: the /api browser trust fence -- the manager visits with the Host node-<id>:port, and
      // without being on the default loopback trust list that is a 403 forbidden (measured in a container).
      Cmd: ['--port', String(d.port), '--trusted-host', `node-${nodeId}`, `node-${nodeId}:${String(d.port)}`],
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      Labels: { [MANAGED_LABEL]: 'true', [NODE_LABEL]: nodeId },
      WorkingDir: '/workspace',
      HostConfig: {
        NetworkMode: d.network,
        // Capability three v1: a node's GUI port is published to the host's loopback only -- the target of the SSH
        // tunnel (the browser reaches 127.0.0.1:<port> through the user's own ssh -L); it never enters the public face.
        PortBindings: {
          [`${d.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(d.port) }],
        },
        Binds: [
          ...Object.entries(d.hostVolumes).map(([host, containerPath]) => `${host}:${containerPath}`),
          ...Object.entries(d.namedVolumes).map(([volume, containerPath]) => `${volume}:${containerPath}`),
        ],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      // Hive plan 2 P6, measured root cause: the manager's probe URL is http://node-<id>:port, but compose's
      // embedded DNS only knows compose service names -- a container the manager pulled itself must register a network
      // alias explicitly, or DNS resolution fails (fetch failed). Give both shapes an alias: node-<id> and <id>.
      NetworkingConfig: {
        EndpointsConfig: {
          [d.network]: { Aliases: [`node-${nodeId}`, nodeId] },
        },
      },
    })
    await container.start()
    return container.id
  }

  /** Stop and remove the container (stopping = removing: all the state is in the volumes, the container itself is stateless). */
  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId)
    await container.stop({ t: 5 }).catch(() => undefined)
    await container.remove({ force: true }).catch(() => undefined)
  }

  /** Container logs (the last tail lines). The promise form returns a Buffer (the dockerode contract). */
  async logs(containerId: string, tail: number): Promise<string> {
    const output = await this.docker.getContainer(containerId).logs({ stdout: true, stderr: true, tail, timestamps: false })
    return Buffer.isBuffer(output) ? output.toString('utf8') : String(output)
  }

  /** Every manager-managed node container on this machine (reconciliation is bounded by the label). */
  async listManaged(): Promise<ManagedContainerInfo[]> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } })
    return list.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? c.Id).replace(/^\//, ''),
      labels: c.Labels ?? {},
      state: c.State === 'running' ? 'running' : c.State === 'exited' ? 'exited' : 'other',
    }))
  }

  /** Container runtime facts (env and image ID), used in reconciliation to decide whether a running container still matches the current config. */
  async runtimeFacts(containerId: string): Promise<{ env: string[]; imageId: string } | null> {
    try {
      const info = await this.docker.getContainer(containerId).inspect()
      return { env: info.Config.Env ?? [], imageId: info.Image }
    } catch {
      return null
    }
  }

  /** The image ID behind the current tag (rebuilding over a tag changes the ID -- harder evidence than the tag name). */
  async imageIdOf(image: string): Promise<string | null> {
    try {
      const info = await this.docker.getImage(image).inspect()
      return info.Id
    } catch {
      return null
    }
  }

  /**
   * Whether a worker container still matches the current expectation (Hive plan 2 P6, measured root cause: after a
   * reinstall an old container with an old GW_KEY was claimed by reconciliation -> sandbox 401; and a container on the
   * old image was not spotted after a same-tag rebuild -> the new entrypoint never took effect). Compares: the GW_KEY environment value + the image ID (not the tag name).
   */
  static matchesSpec(facts: { env: string[]; imageId: string }, sandboxKey: string, expectedImageId: string | null): boolean {
    if (expectedImageId !== null && facts.imageId !== expectedImageId) return false
    const gwEntry = facts.env.find((e) => e.startsWith('GW_KEY='))
    if (sandboxKey === '') return gwEntry === undefined || gwEntry === 'GW_KEY='
    return gwEntry === `GW_KEY=${sandboxKey}`
  }

  /**
   * Hive plan 2 P4: run a one-shot tool container (for backing up/restoring a node home volume), with
   * stdin/stdout wired through an attach stream (stdin = read a file and feed the container, stdout = collect the stream into a file).
   *
   * Debt R10, proven root cause: the old implementation made the "backup directory" a bind too -- but
   * /app/data/backups inside the manager container is a bind mount's container-side path, and dockerd resolved it
   * with host semantics into a directory that does not exist on the host, so the tar output landed in a ghost
   * directory and the manager could not read it (ENOENT). Streaming does not rely on the "host path = container path" assumption: bind named volumes only, and move the data over stdin/stdout.
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
      // stdin is fed into the attach stream through pipeline (the file ends = EOF; the container hanging up with EPIPE
      // first is normal, and the exit code is the backstop error). Without stdin, AttachStdin:false and the daemon side has already closed stdin.
      const stdinDone =
        io.stdin === undefined
          ? Promise.resolve()
          : pipeline(createReadStream(io.stdin), stream).catch(() => undefined)
      // Wait for the attach stream to close (stdout/stderr fully delivered) before judging the exit code -- only then does the error message carry the whole stderr.
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
