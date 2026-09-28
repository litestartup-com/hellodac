/**
 * Hive plan 2 P4 + Debt A1: backup encryption.
 *
 * Format v2 (current): `OHDSH-BAK2` (8B magic) + 12B random IV + AES-256-GCM ciphertext + 16B
 * authTag. GCM authenticates on its own -- tampering with any byte (IV/ciphertext/tag) fails to
 * decrypt, so a silently damaged backup is refused loudly at restore (the last line of DR).
 *
 * Format v1 (historical, read-only compatibility): 16B IV + AES-256-CBC ciphertext, no auth. Key =
 * `sha256("ohdsh-backup:" + SESSION_SECRET)`. The upgrade does not break the restore chain:
 * decryptFile branches on the magic, so old archives still decrypt.
 *
 * Key: `BACKUP_KEY` first (64 hex = 32B, independent of the session secret, so rotating
 * SESSION_SECRET no longer makes old backups undecryptable); when unset it falls back to
 * `deriveBackupKey` (HKDF from SESSION_SECRET, unlike the old single-round sha256, v2 only).
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, createReadStream, createWriteStream, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

const V2_MAGIC = Buffer.from('OHDSH-BAK2', 'utf8')
const V2_IV_LEN = 12
const V2_TAG_LEN = 16
const HEADER_LEN = V2_MAGIC.length + V2_IV_LEN

/** v2 key derivation (HKDF: SHA-256 with domain-separated salt/info, nothing like v1's single-round sha256). */
export const deriveBackupKey = (sessionSecret: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(sessionSecret, 'utf8'), Buffer.from('ohdsh-backup-v2', 'utf8'), Buffer.from('backup-key', 'utf8'), 32))

/** v1 key derivation (the old algorithm, used only to decrypt v1 archives). */
export const deriveLegacyBackupKey = (sessionSecret: string): Buffer =>
  createHash('sha256').update(`ohdsh-backup:${sessionSecret}`).digest()

const envKey = (): Buffer | null => {
  const raw = process.env.BACKUP_KEY ?? ''
  if (raw === '') return null
  const buf = Buffer.from(raw, 'hex')
  if (buf.length !== 32 || buf.toString('hex') !== raw.toLowerCase()) {
    throw new Error('BACKUP_KEY must be 64 hex characters (32 bytes); remove it to fall back to a SESSION_SECRET-derived key')
  }
  return buf
}

/** The key actually used to encrypt/decrypt v2: BACKUP_KEY when set, otherwise the HKDF derivation. */
const v2Key = (sessionSecret: string): Buffer => envKey() ?? deriveBackupKey(sessionSecret)

/**
 * A plaintext file -> a v2 encrypted file (format: magic + 12B IV + GCM ciphertext + 16B tag).
 * <out>.tmp is written first and then renamed: a failure never leaves a half-made file that would be
 * taken for the newest archive (review B4, medium severity).
 */
export const encryptFile = async (plainPath: string, outPath: string, sessionSecret: string): Promise<void> => {
  const tmpPath = `${outPath}.tmp`
  const iv = randomBytes(V2_IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', v2Key(sessionSecret), iv)
  const output = createWriteStream(tmpPath)
  output.write(V2_MAGIC)
  output.write(iv)
  try {
    await pipeline(createReadStream(plainPath), cipher, output)
    appendFileSync(tmpPath, cipher.getAuthTag())
    renameSync(tmpPath, outPath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
}

/** Read the file header to tell the archive version (no magic = the v1 historical format). */
const versionOf = (encPath: string): 'v1' | 'v2' => {
  const fd = openSync(encPath, 'r')
  const head = Buffer.alloc(V2_MAGIC.length)
  readSync(fd, head, 0, head.length, 0)
  closeSync(fd)
  return head.equals(V2_MAGIC) ? 'v2' : 'v1'
}

/**
 * An encrypted file -> a plaintext file. Branching on the magic:
 * - v2: key = BACKUP_KEY or the HKDF derivation; GCM auth throws on tampering or a wrong key;
 * - v1: key = the legacy derivation, compatible with the archives already in production.
 * `<out>.tmp` is written first and then renamed: a failure mid-decryption (tampering/wrong key)
 * never leaves a half-made target file that would count as a successful restore (Debt R2 review).
 */
export const decryptFile = async (encPath: string, outPath: string, sessionSecret: string): Promise<void> => {
  const tmpPath = `${outPath}.tmp`
  try {
    if (versionOf(encPath) === 'v2') {
      const size = statSync(encPath).size
      if (size < HEADER_LEN + V2_TAG_LEN) throw new Error(`archive is corrupt: too short (${size} bytes)`)
      const fd = openSync(encPath, 'r')
      const iv = Buffer.alloc(V2_IV_LEN)
      readSync(fd, iv, 0, iv.length, V2_MAGIC.length)
      const tag = Buffer.alloc(V2_TAG_LEN)
      readSync(fd, tag, 0, tag.length, size - V2_TAG_LEN)
      closeSync(fd)
      const decipher = createDecipheriv('aes-256-gcm', v2Key(sessionSecret), iv)
      decipher.setAuthTag(tag)
      await pipeline(createReadStream(encPath, { start: HEADER_LEN, end: size - V2_TAG_LEN - 1 }), decipher, createWriteStream(tmpPath))
    } else {
      // v1 (historical CBC, no auth): key = the legacy derivation; a wrong key or truncation trips the padding
      const fd = openSync(encPath, 'r')
      const iv = Buffer.alloc(16)
      readSync(fd, iv, 0, 16, 0)
      closeSync(fd)
      const decipher = createDecipheriv('aes-256-cbc', deriveLegacyBackupKey(sessionSecret), iv)
      await pipeline(createReadStream(encPath, { start: 16 }), decipher, createWriteStream(tmpPath))
    }
    renameSync(tmpPath, outPath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
}
