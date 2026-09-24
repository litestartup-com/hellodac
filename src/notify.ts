import { randomUUID } from 'node:crypto'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'

/**
 * 蜂群 P5.3：站内通知。事件源（cron 成败、预算熔断、主脑任务完成…）各自
 * 调用，本模块只管落库。节流/去重是下一轮的事（§3.7 第 11 条已记）。
 */
export interface NotificationInput {
  kind: string
  title: string
  body: string
  /** 站内路径，如 /chat/<id>；null = 纯告知，不跳转。 */
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
