import { randomUUID } from 'node:crypto'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'

/**
 * Hive P5.3: in-app notifications. Event sources (cron success/failure, budget breaker, brain task done, ...)
 * call in; this module only writes rows. Throttling/dedup is a later round (noted as §3.7 item 11).
 */
export interface NotificationInput {
  kind: string
  title: string
  body: string
  /** In-app path, e.g. /chat/<id>; null = informational only, nothing to open. */
  link?: string | null
}

export const notify = (db: Db, input: NotificationInput): void => {
  db.insert(schema.notification)
    .values({
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      at: Date.now(),
      read: 0,
    })
    .run()
}
