/**
 * 债务 D5:env 集中 zod 校验——.env 变量单一 schema,boot 一次 fail loud。
 *
 * 旧实现只手工校验 SESSION_SECRET(长度)与端点 key_ref(非空),其余变量
 * 零校验、`.env.example`/gen-env.sh 靠人工对齐。本 schema 收口已知变量
 * 的形状与缺省;`GW_KEY_*` 等 key_ref 动态寻址的变量经 passthrough 原样
 * 保留(由 loadConfig 的端点解析继续逐个校验非空)。
 */
import { z } from 'zod'

export const envSchema = z
  .object({
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters (see .env.example)'),
    MANAGER_USERNAME: z.string().default('admin'),
    MANAGER_INITIAL_PASSWORD: z.string().optional(),
    TRUST_PROXY: z.string().optional(),
    BACKUP_KEY: z.string().optional(),
    BRAIN_TOKEN: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    DSH_NODE_IMAGE: z.string().optional(),
    HOST_UID: z.string().optional(),
    HOST_GID: z.string().optional(),
    LOG_LEVEL: z.string().optional(),
    NODE_ENV: z.string().optional(),
  })
  .passthrough()

export type Env = z.infer<typeof envSchema>
