import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply } from 'fastify'
import { desc, isNull } from 'drizzle-orm'
import { loadConfig } from './config.js'
import { openDb, schema } from './db/index.js'
import { backupNow } from './backup.js'
import { generatePassword, hashPassword } from './auth/password.js'
import { pruneExpiredSessions } from './auth/session.js'
import { makeRequirePage, makeRequireUser } from './auth/hooks.js'
import { buildClients, dummyGatewayClient } from './gateway/client.js'
import { getChat } from './chat/store.js'
import { buildUpstreamClients, closeAllMux } from './upstream/client.js'
import { setMuxLogger } from './upstream/mux.js'
import { reconcileAll, startPeriodicReconcile } from './reconcile/index.js'
import { buildNodeSupervisors } from './nodes/registry.js'
import { DockerRunner } from './nodes/docker-runner.js'
import { recordAudit } from './audit.js'
import { makeCsrfHook } from './routes/auth.js'
import { registerAuditRoutes } from './routes/audit.js'
import { registerApiKeyRoutes } from './routes/keys.js'
import { registerServiceRoutes } from './routes/services.js'
import { collectNodeHomes, packNodeHomes } from './nodebackup.js'
import { seedEmptyWorkspaces } from './workspace/seed.js'
import { provisionBrainToken, renderFleetDoc } from './workspace/fleet-doc.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerStatusRoutes } from './routes/status.js'
import { registerWorkspaceRoutes } from './routes/workspace.js'
import { registerRunRoutes } from './routes/run.js'
import { closeBoardWatchers, registerBoardRoutes } from './routes/board.js'
import { closeChatRelays, registerChatRoutes } from './routes/chat.js'
import { registerUsageRoutes } from './routes/usage.js'
import { registerCronRoutes } from './routes/cron.js'
import { registerInternalRoutes } from './routes/internal.js'
import { registerAgentsRoutes, enqueueAgentCommand, subscribeAgentCommandResults, readAgentLog } from './routes/agents.js'
import { registerNodesRoutes } from './routes/nodes.js'
import { registerSkillsRoutes } from './routes/skills.js'
import { registerNotificationRoutes } from './routes/notifications.js'
import { registerMetricsRoutes } from './metrics.js'
import { registerProvisionRoutes } from './routes/provision.js'
import { createFleetWatchdog } from './fleet/watchdog.js'
import { Scheduler } from './cron/schedule.js'
import { registerI18nRoutes } from './routes/i18n.js'
import { assetCacheHeaders, buildAllPages, buildStandalonePage } from './pages.js'
import { LOCALE_COOKIE, LOCALES, resolveLocale } from './i18n/index.js'
import { switchLocale } from './locale-switch.js'
import { registerSecurityHeaders } from './security.js'
import { startPublicApi } from './public-api/listener.js'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')

const main = async (): Promise<void> => {
  const config = loadConfig()
  const { db, applied } = openDb(config.databasePath)

  const app = Fastify({
    // Debt B6: one requestId per request, so logs and debugging run through by request
    genReqId: (request) =>
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID().slice(0, 8),
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'production'
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
    },
    // P0-4: the reverse-proxy trust boundary is decided by TRUST_PROXY, and by default forwarded headers are not
    // trusted -- login rate limiting keys on request.ip, and trusting everything would let an attacker bypass the only
    // brute-force defence by changing X-Forwarded-For. To get the real client IP behind a proxy, name the trusted hop in .env (e.g. TRUST_PROXY=127.0.0.1).
    trustProxy: config.trustProxy ?? false,
  })

  if (applied.length > 0) app.log.info(`applied database migrations: ${applied.join(', ')}`)
  for (const warning of config.warnings) app.log.warn(warning)
  const pruned = pruneExpiredSessions(db)
  if (pruned > 0) app.log.info(`pruned ${pruned} expired session(s)`)

  // First boot: create the admin account. Without this the instance would come
  // up with no way to log in.
  const existing = db.select({ id: schema.user.id }).from(schema.user).limit(1).all()
  if (existing.length === 0) {
    const password = config.initialUser.password ?? generatePassword()
    const generated = config.initialUser.password === null
    db.insert(schema.user)
      .values({
        username: config.initialUser.username,
        passwordHash: await hashPassword(password),
        createdAt: Date.now(),
        mustChangePassword: 1,
      })
      .run()
    app.log.warn(`created initial user "${config.initialUser.username}"`)
    if (generated) {
      // Printed exactly once, and only because no password was configured.
      app.log.warn(`generated password: ${password}  <-- save it now, it will not be shown again`)
    }
  }

  // Mirror configured agents into the registry so later stages (bootstrap,
  // runner) read one source of truth at runtime.
  // ↓ Converged into src/reconcile (A list #2, the single entry): the DB mirror / stale runs / orphan chats
  //   / the fleet push / node claiming all go through reconcileAll, see the call site below.

  const clients = buildClients(config.endpoints)
  const upstreamClients = buildUpstreamClients(config.endpoints)
  // Debt card chain (2026-09-17): the diagnostic log for dropped mux frames and reconnects goes into app.log --
  // when a question/approval frame is rejected by the discrimination or lost in the outage window, the missing card leaves a trace.
  setMuxLogger((line) => app.log.warn(line))
  // Hive plan 2 P2b: connect docker.sock only when some node uses runner=docker (the bare-metal path has zero dependencies)
  const needsDocker = Object.values(config.endpoints).some((e) => e.spawn?.runner === 'docker')
  const dockerRunner = needsDocker ? new DockerRunner({}) : null
  const nodeSupervisors = buildNodeSupervisors(config, {
    gateway: (id) => clients.get(id),
    upstream: (id) => upstreamClients.get(id),
    log: (line) => app.log.info(line),
    ...(dockerRunner === null ? {} : { docker: dockerRunner }),
    // Capability four (M1-4): the agent runner trio -- enqueue a command / subscribe to results / read the returned log
    agentCommand: (agentId, type, payload) => enqueueAgentCommand(db, agentId, type as import('./routes/agents.js').AgentCommandType, payload),
    agentResult: (commandId, cb) => subscribeAgentCommandResults((cid, ok) => {
      if (cid === commandId) cb(ok)
    }),
    agentLog: (agentId, nodeId) => readAgentLog(agentId, nodeId),
    // Capability four (M1-6): the fleet.md derived push (the same generator as the bare-metal path)
    fleetDoc: () => renderFleetDoc(config),
  })
  // Hive plan 2 P6: the container path has no setup step -- an empty workspace is seeded with the templates at boot
  // (the brain's AGENTS.md/skill manual, the personal agent's template pages), and a workspace with any existing file is never touched.
  const seededWorkspaces = seedEmptyWorkspaces(
    Object.values(config.agents).map((a) => ({ id: a.id, workspacePath: a.workspacePath })),
    (line) => app.log.info(line),
  )
  if (seededWorkspaces.length > 0) app.log.info(`workspaces seeded: ${seededWorkspaces.join(', ')}`)
  // Bare-metal form: the brain token is written into the node user's HOME (the container form derives it in the node entrypoint).
  // The DSH tool sandbox strips env vars containing TOKEN (DSH-FACTS §2), so the skill manual reads $HOME/.brain-auth.
  const brainAgent = config.agents['brain']
  const brainSpawn = brainAgent === undefined ? undefined : config.endpoints[brainAgent.endpoint]?.spawn
  if (brainSpawn !== undefined && brainSpawn !== null && brainSpawn.runner === 'process') {
    provisionBrainToken(undefined, (line) => app.log.info(line))
  }

  // One reconcile entry (A list #2): the DB registry mirror, stale-run convergence, orphan-chat archiving,
  // the fleet.md derived push and managed-node claiming (docker reconcile / process spawn) --
  // boot and config changes (the provision route) share this one entry, and runHygiene is on for boot only.
  const reconcileDeps = { db, config, supervisors: nodeSupervisors, docker: dockerRunner, log: (line: string) => app.log.info(line) }
  await reconcileAll(reconcileDeps, { runHygiene: true })
  // Road work A2: periodic reconcile (the interval is reconcile_interval_minutes, 0 = off).
  // healOnly: a cold node a person stopped by hand is left alone, and a node that fell offline on failure heals itself.
  const stopPeriodicReconcile = startPeriodicReconcile(
    reconcileDeps,
    config.reconcileIntervalMs ?? 10 * 60_000,
  )
  app.addHook('onClose', async () => { stopPeriodicReconcile() })
  const requireUser = makeRequireUser(db)
  const requirePage = makeRequirePage(db)
  // Secure cookies require HTTPS; on plain-HTTP localhost dev they would simply
  // never be sent back, making login appear broken.
  const secureCookies = process.env.NODE_ENV === 'production'

  // P1-1: security response headers (CSP and friends) -- registered before any route, covering pages and APIs alike.
  // secure also decides whether HSTS goes out: sending HSTS over plain HTTP would pin the site shut.
  await registerSecurityHeaders(app, secureCookies)
  await app.register(cookie, { secret: config.sessionSecret })
  await app.register(rateLimit, { global: false })
  // Hive plan 2 P3: CSRF -- a non-GET API request must carry an X-CSRF-Token matching the cookie
  // (double submit). Exempt: /api/login (no chat yet) and /api/internal/* (brain-token auth).
  // P6 self-heal: an old chat from before the upgrade lacks the csrf cookie -> the server reissues it and the frontend retries the 403 once.
  app.addHook('onRequest', makeCsrfHook(secureCookies))
  // `no-cache` means "you may keep it, but ask before using it" -- a conditional
  // request answered by a 304, not a re-download. The page URLs carry a content
  // hash so they rarely even get here; this covers what a hash cannot reach,
  // namely one module importing another by a bare path. Anything is better than
  // the default, under which an edited stylesheet may simply never arrive and the
  // symptom looks like a CSS bug rather than a cached file.
  await app.register(fastifyStatic, {
    root: join(publicDir, 'assets'),
    prefix: '/assets/',
    cacheControl: false,
    setHeaders: assetCacheHeaders,
  })

  // Composed once at boot, so a missing fragment (or a missing i18n key) fails
  // here rather than in somebody's browser. One set of HTML per locale.
  const pages = buildAllPages(publicDir, LOCALES)
  // The login page sits outside the shell and is pre-rendered per locale on its own (see buildStandalonePage in pages.ts).
  const loginPages = new Map(LOCALES.map((locale) => [locale, buildStandalonePage(publicDir, 'login.html', locale)]))
  // HTML documents carry no version of their own: stale-proofing them is one
  // header. (Assets are the opposite -- hash-versioned URLs plus must-revalidate
  // -- so a restart changes their URL, but a document URL never does.)
  const noCache = (reply: FastifyReply): FastifyReply => reply.header('cache-control', 'no-store')

  /**
   * Locale resolution and switching: when `?lang=` matches, write the cookie and 302 back to the clean URL (lang removed),
   * so the language preference is shareable and bookmarkable and the lang parameter never stays in the address bar.
   */
  const localeOf = (request: {
    query?: unknown
    cookies?: Record<string, string | undefined>
    headers?: Record<string, unknown>
  }) =>
    resolveLocale({
      query: (request.query as { lang?: unknown } | undefined)?.lang,
      cookie: request.cookies?.[LOCALE_COOKIE],
      accept: typeof request.headers?.['accept-language'] === 'string' ? (request.headers['accept-language'] as string) : undefined,
    })

  /**
   * The locale switch hangs on the **global onRequest**: ahead of every preHandler / route handler.
   *
   * The measured scene (2026-09-25, a user reported "clicking the language switch does nothing"):
   *   GET /login?lang=zh-CN  -> 302 /login with Set-Cookie: dac_lang=zh-CN  OK
   *   GET /nodes?lang=zh-CN  -> 302 /login with **no cookie**              FAIL
   * Protected pages hang `{ preHandler: requirePage }`, and preHandler runs before the route handler, so with no chat the
   * guard 302s first and the switchLocale written inside the handler never gets a chance to run.
   * Hung on a hook instead, every page (public/protected/added later) gets the switch for free.
   */
  app.addHook('onRequest', async (request, reply) => {
    const switched = switchLocale(request, reply)
    if (switched !== null) return reply
  })

  const page =
    (name: string) =>
    async (request: { cookies?: Record<string, string | undefined>; headers?: Record<string, unknown> }, reply: FastifyReply): Promise<FastifyReply> => {
      // `?lang=` is already handled by the onRequest hook above (it runs ahead of the auth guard);
      // this only picks the pre-rendered page for the locale from the cookie/Accept-Language.
      const html = pages.get(localeOf(request))?.get(name)
      return noCache(reply.type('text/html').send(html))
    }

  // Hive Q5: the home page is gone. / and /app both go straight to the most recent chat -- redirecting was all the home
  // page had left to do, so let it be nothing but a redirect. With no chat at all it lands on the /chat empty state
  // (chat.js prompts you to pick a chat in the sidebar), and a GET never has a creation side effect.
  const landing = async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> => {
    const rows = db
      .select()
      .from(schema.chat)
      .where(isNull(schema.chat.removedAt))
      .orderBy(desc(schema.chat.lastActiveAt))
      .all()
    const latest = rows.find((row) => config.agents[row.agentId] !== undefined)
    return reply.redirect(latest === undefined ? '/chat' : `/chat/${encodeURIComponent(latest.id)}`, 302)
  }
  app.get('/', landing)
  app.get('/app', landing)
  // The only page outside the shell, on purpose: the sidebar is agent data, and
  // there is no session yet to fetch it with. The locale is resolved from the cookie/Accept-Language the same way
  // (the login page has to offer a language choice too, DAC v1.0.0).
  app.get(
    '/login',
    async (request: { cookies?: Record<string, string | undefined>; headers?: Record<string, unknown> }, reply: FastifyReply) => {
      // `?lang=` is handled by the onRequest hook here too; this picks the page from the cookie/Accept-Language.
      return noCache(reply.type('text/html').send(loginPages.get(localeOf(request))))
    },
  )
  // One page for every agent, and which conversation to draw comes from the
  // path. `/chat` without an id is the empty state, which is what the "new
  // conversation" action navigates to before a chat row exists.
  //
  // Public-edition trim (DAC v1.0.0): the /board/:id and /crons pages are retired; both of their
  // backend APIs (/api/board/*, /api/crons/*, /api/internal/*) are all kept -- the brain still produces from
  // the dashboard files and the scheduler engine still runs, so only the outward pages went.
  app.get('/chat', { preHandler: requirePage }, page('chat'))
  app.get<{ Params: { id: string } }>('/chat/:id', { preHandler: requirePage }, page('chat'))
  app.get('/archive', { preHandler: requirePage }, page('archive'))
  app.get('/spend', { preHandler: requirePage }, page('spend'))
  app.get('/nodes', { preHandler: requirePage }, page('nodes'))
  app.get('/runs', { preHandler: requirePage }, page('runs'))
  app.get('/skills', { preHandler: requirePage }, page('skills'))
  // Hive plan 2 P3: the password-change page (where a forced change lands) and the audit page
  app.get('/password', { preHandler: requirePage }, page('password'))
  app.get('/audit', { preHandler: requirePage }, page('audit'))
  // Public API: the key management page (the back-office face; the customer face is /v1 on 8081, and the two doors do
  // not recognise each other). Miss this line and /keys 404s while /api/keys works -- pages-routes.test.ts now guards that.
  app.get('/keys', { preHandler: requirePage }, page('keys'))
  // P2.5: the outward-service overview. Same trap as /keys above: the page needs its own route line.
  app.get('/services', { preHandler: requirePage }, page('services'))

  // P1-5: wipe the initial password from .env once the password change succeeds.
  // Debt R6: the path now comes from config.envPath (derived from the single source of truth; the old dist/../.env
  // reached the wrong file under a non-default deployment layout).
  // The client dictionary/brand endpoint (the CSP forbids inline scripts, so the client fetches it once at start).
  registerI18nRoutes(app)
  registerAuthRoutes(app, db, secureCookies, config.envPath ?? join(here, '..', '.env'))
  registerAuditRoutes(app, db, requireUser)
  // The key management face of the public API (back office; the customer face is in public-api/)
  registerApiKeyRoutes(app, config, db, requireUser)
  // P2.5: the outward-service overview (read-only; liveness comes from the same supervisor state dispatch reads).
  registerServiceRoutes(app, {
    db,
    config,
    requireUser,
    isOnline: (agentId) => {
      const agent = config.agents[agentId]
      if (agent === undefined) return false
      return nodeSupervisors.get(agent.endpoint)?.current.state === 'live'
    },
  })
  registerStatusRoutes(app, config, db, clients, requireUser, upstreamClients, nodeSupervisors)
  registerWorkspaceRoutes(app, config, requireUser)
  registerRunRoutes(app, config, db, clients, requireUser, upstreamClients)
  registerBoardRoutes(app, config, requireUser)
  // The public chat face reuses the same turn runner as the back office (one instance = one copy of the "this chat is running" state).
  const chatTurns = registerChatRoutes(app, config, db, clients, requireUser, upstreamClients, (actor, kind, detail) =>
    recordAudit(db, { actor, kind, detail }))
  registerUsageRoutes(app, config, db, requireUser)
  const scheduler = new Scheduler({
    db,
    config,
    clients,
    upstreamClients,
    log: {
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
      error: (m) => app.log.error(m),
    },
  })
  registerCronRoutes(app, config, db, scheduler, requireUser)
  // Hive P2: the brain-side internal API (127.0.0.1 only, plus X-Brain-Token).
  registerInternalRoutes(app, config, db, clients, upstreamClients, scheduler)
  // Hive P3: the node (fleet) view. Audit callback: every node operation leaves a trace.
  registerNodesRoutes(app, config, nodeSupervisors, clients, upstreamClients, requireUser, (actor, kind, detail) =>
    recordAudit(db, { actor, kind, detail }),
  )
  registerProvisionRoutes(app, config, requireUser, {
    db,
    supervisors: nodeSupervisors,
    clients,
    upstreamClients,
    ...(dockerRunner === null ? {} : { docker: dockerRunner }),
    // Capability four (M1-7): needed to create an agent node (makeSupervisor's agent trio plus fleet)
    agentCommand: (agentId, type, payload) => enqueueAgentCommand(db, agentId, type as import('./routes/agents.js').AgentCommandType, payload),
    agentResult: (commandId, cb) => subscribeAgentCommandResults((cid, ok) => {
      if (cid === commandId) cb(ok)
    }),
    agentLog: (agentId, nodeId) => readAgentLog(agentId, nodeId),
    fleetDoc: () => renderFleetDoc(config),
  })
  // Capability four (Fleet M1-2): the node-agent registration chain (join issuance / register exchange / revocation).
  registerAgentsRoutes(
    app,
    db,
    requireUser,
    (actor, kind, detail) => recordAudit(db, { actor, kind, detail }),
    // Incident regression (2026-09-25, ubuntu-focal went missing): a machine coming back online = its nodes most
    // likely need pulling up again (after a restart the agent returns first and the nodes are not up yet). This goes
    // through supervisor.resume rather than a healOnly reconcile -- after a restart the nodes are cold, and healOnly
    // deliberately skips cold (to protect nodes a person stopped by hand), so following it they would never come up.
    // resume's semantics: start a cold one, leave a live one alone, and do not touch one stopped by hand.
    (agentId) => {
      const hosted = Object.entries(config.endpoints)
        .filter(([, ep]) => ep.spawn?.runner === 'agent' && ep.spawn.host === agentId)
      if (hosted.length === 0) return
      app.log.info(`agent ${agentId} came back online → resuming its nodes: ${hosted.map(([id]) => id).join(', ')}`)
      for (const [id, ep] of hosted) {
        const supervisor = nodeSupervisors.get(id)
        if (supervisor === undefined || ep.spawn === null) continue
        supervisor.resume(ep.spawn)
      }
    },
  )
  registerSkillsRoutes(app, config, requireUser)
  registerNotificationRoutes(app, db, requireUser)
  // Debt B6: the /metrics snapshot endpoint (protected)
  registerMetricsRoutes(app, db, requireUser)

  // The public facade (design doc manager/topics/public-api.md §3): its own listener, its own auth.
  // Failing to start does not drag the main service down (the listener records state + an error log internally), so only a nullable handle is kept here.
  let publicApiHandle: { close: () => Promise<void> } | null = null

  const close = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`)
    // Close the public face first: a customer request still being handled should not be left hanging after the main service packs up.
    await publicApiHandle?.close().catch((error: unknown) => app.log.warn(`public API close failed: ${String(error)}`))
    // Open SSE streams and filesystem watchers would otherwise keep the event
    // loop alive and turn a clean stop into a hang.
    closeBoardWatchers()
    closeChatRelays()
    closeAllMux()
    scheduler.stop()
    // Hive P1: the manager takes the nodes it started with it when it exits (taskkill /T is issued synchronously, leaving no orphans).
    for (const supervisor of nodeSupervisors.values()) supervisor.stop()
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void close('SIGINT'))
  process.on('SIGTERM', () => void close('SIGTERM'))

  await app.listen({ host: config.listen.host, port: config.listen.port })
  // The public face opens only after the back office is up: what customers get is "an API that works", not "the API is
  // there but the back office is not ready". It deliberately sits after listen and before scheduler -- a facade failure affects no later startup step.
  publicApiHandle = await startPublicApi({
    config,
    db,
    log: (line, level) => (level === 'error' ? app.log.error(line) : app.log.info(line)),
    ports: {
      // The liveness rule matches the back office: read the supervisor's state machine rather than sending another liveness
      // request (two liveness rules = two truths, and "the UI says online while dispatch says offline" is the hardest kind to debug).
      isOnline: (agentId) => {
        const agent = config.agents[agentId]
        if (agent === undefined) return false
        return nodeSupervisors.get(agent.endpoint)?.current.state === 'live'
      },
      runTurn: async ({ chatId, agentId, text, apiKeyId }) => {
        const chat = getChat(db, chatId)
        if (chat === null) throw new Error(`unknown conversation ${chatId}`)
        const agent = config.agents[agentId]
        if (agent === undefined) throw new Error(`agent ${agentId} is not in the config`)
        const driver = config.endpoints[agent.endpoint]?.driver ?? 'gateway'
        const upstream = upstreamClients.get(agent.endpoint) ?? null
        const client = clients.get(agent.endpoint)
        if (driver === 'apiproxy' && upstream === null) throw new Error(`endpoint ${agent.endpoint} has no apiproxy client`)
        if (driver === 'gateway' && client === undefined) throw new Error(`endpoint ${agent.endpoint} has no gateway client`)
        return await chatTurns.startChatTurn(chat, agent, client ?? dummyGatewayClient(), upstream, driver, text, { apiKeyId })
      },
    },
  })
  // Started only once the process is fully up: the stale-run sweep above has to
  // have cleared the previous process's locks, or the first fire would collide
  // with a run that no longer exists.
  scheduler.start()
  app.log.info(
    `agents: ${Object.keys(config.agents).join(', ') || '(none)'} | endpoints: ${Object.keys(config.endpoints).join(', ')}`,
  )

  // Hive P6: a 15-minute database snapshot (RPO), with the retention policy in backup.ts. A failed backup only logs
  // and does not exit -- the manager is worth more than the backup, but a failure has to be visible.
  // A production disk lesson (2026-09-20): a small production disk was eaten up by snapshots plus home-directory packing --
  // off by default, turned on explicitly with backup.auto: true; a manual npm run backup and the pre-update backup are unaffected.
  const backupDir = join(dirname(config.databasePath), 'backups')
  const autoBackup = async (): Promise<void> => {
    try {
      // Debt A5: source-of-truth paths come only from what loadConfig resolved (a single source, no more dist/../ derivation)
      const result = await backupNow(
        config.databasePath,
        config.configPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'manager.config.yaml'),
        config.envPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
        backupDir,
        config.sessionSecret,
      )
      app.log.info(`backup: ${result.snapshot.file} (${result.snapshot.bytes} bytes)${result.pruned.length > 0 ? `, pruned ${result.pruned.length}` : ''}`)
      // Hive plan 2 P3: audit trace (the automatic backup, actor = system)
      recordAudit(db, { actor: 'system', kind: 'backup', detail: `snapshot ${result.snapshot.file}` })
      // Hive plan 2 P4: pack and encrypt the node homes as well (skipped when an archive from the last 6 hours already exists)
      const nodeEntries = collectNodeHomes(config)
      if (nodeEntries.length > 0) {
        try {
          const packed = await packNodeHomes(nodeEntries, backupDir, config.sessionSecret, dockerRunner ?? undefined)
          if (packed.length > 0) app.log.info(`backup: node homes → ${packed.join(', ')}`)
        } catch (error) {
          app.log.error(`node home backup failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      app.log.error(`backup failed: ${(error as Error).message}`)
    }
  }
  if (config.backupAuto === true) {
    const intervalMs = config.backupIntervalMs ?? 15 * 60_000
    setInterval(() => void autoBackup(), intervalMs)
    app.log.info(`auto backup: on (every ${Math.round(intervalMs / 60_000)} minutes)`)
  } else {
    app.log.info('auto backup: off (backup.auto=false) — run npm run backup by hand, or turn it on via backup.auto in manager.config.yaml')
  }

  // Capability four (Fleet M3-3, the §13 patch brought forward): the fleet watchdog -- an agent going offline / an
  // abnormal agent node is edge-triggered into the bell (one sweep every 30s, unread dedupe keeps restarts from flooding it). A failure only leaves a trace, never exits.
  const fleetWatchdog = createFleetWatchdog({
    db,
    nodeStates: () =>
      Object.keys(config.endpoints).map((id) => {
        const ep = config.endpoints[id]
        const sup = nodeSupervisors.get(id)
        return sup === undefined || ep === undefined
          ? { id, state: 'unknown', runner: 'process', host: null, lastError: null }
          : { id, state: sup.current.state, runner: ep.spawn?.runner ?? 'process', host: ep.spawn?.host ?? null, lastError: sup.current.lastError }
      }),
  })
  const watchdogTimer = setInterval(() => {
    try {
      const result = fleetWatchdog()
      if (result.alerts > 0) app.log.info(`fleet watchdog: ${result.alerts} alerts sent to the bell`)
    } catch (error) {
      app.log.warn(`fleet watchdog failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, 30_000)
  watchdogTimer.unref()
  app.log.info('fleet watchdog: started (agent offline / node abnormal → in-app bell, one sweep every 30s)')
}

main().catch((error: unknown) => {
  // Config and migration failures land here. Print plainly -- the logger may not
  // exist yet, and a stack trace for "SESSION_SECRET is empty" only obscures it.
  console.error(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
