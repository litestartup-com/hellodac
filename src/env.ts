/**
 * Debt D5: env validated centrally with zod -- one schema for the .env variables, failing loud once at boot.
 *
 * The old implementation hand-checked only SESSION_SECRET (length) and the endpoint key_ref (non-empty); every other
 * variable went unvalidated and `.env.example` / gen-env.sh were kept aligned by hand. This schema closes over the
 * shape and defaults of the known variables; dynamically addressed key_refs such as `GW_KEY_*` pass through as they
 * are (loadConfig's endpoint parsing still checks each one for non-emptiness).
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
