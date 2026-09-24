import { randomBytes } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'

/**
 * argon2id with deliberately conservative parameters. This is a single-user
 * self-hosted login, so ~64 MiB and 3 passes cost nothing at the one login per
 * session we expect, and make offline cracking expensive if the db ever leaks.
 */
const OPTIONS = { memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTIONS)

export const verifyPassword = async (stored: string, plain: string): Promise<boolean> => {
  try {
    return await verify(stored, plain)
  } catch {
    // A malformed hash must read as "wrong password", never as a crash that
    // leaks whether the account exists.
    return false
  }
}

export const generatePassword = (): string => randomBytes(12).toString('base64url')
