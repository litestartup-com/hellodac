/**
 * 蜂群2计划 P4 + 债务 A1:备份加密。
 *
 * 格式 v2(当前):`OHDSH-BAK2`(8B magic)+ 12B 随机 IV + AES-256-GCM 密文 +
 * 16B authTag。GCM 自带认证——篡改任意字节(IV/密文/tag)都会解密失败,
 * 静默损坏的备份在恢复时被显性拒绝(灾恢最后一道,静默损坏最致命)。
 *
 * 格式 v1(历史,只读兼容):16B IV + AES-256-CBC 密文,无认证。密钥 =
 * `sha256("ohdsh-backup:" + SESSION_SECRET)`。升级不打断恢复链:
 * decryptFile 按 magic 自动分流,旧归档仍可解。
 *
 * 密钥:优先 `BACKUP_KEY`(64 hex = 32B,独立于会话密钥——轮换 SESSION_SECRET
 * 不再让历史备份不可解);未设置时回退 `deriveBackupKey`(HKDF 派生自
 * SESSION_SECRET,与旧版单轮 sha256 不同,仅用于 v2)。
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, createReadStream, createWriteStream, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

const V2_MAGIC = Buffer.from('OHDSH-BAK2', 'utf8')
const V2_IV_LEN = 12
const V2_TAG_LEN = 16
const HEADER_LEN = V2_MAGIC.length + V2_IV_LEN

/** v2 密钥派生(HKDF:SHA-256,域分离 salt/info 与 v1 的单轮 sha256 完全不同)。 */
export const deriveBackupKey = (sessionSecret: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(sessionSecret, 'utf8'), Buffer.from('ohdsh-backup-v2', 'utf8'), Buffer.from('backup-key', 'utf8'), 32))

/** v1 密钥派生(旧算法,只用于解 v1 归档)。 */
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

/** 加密/解密 v2 时实际使用的密钥:BACKUP_KEY 优先,否则 HKDF 派生。 */
const v2Key = (sessionSecret: string): Buffer => envKey() ?? deriveBackupKey(sessionSecret)

/**
 * 明文文件 → v2 加密文件(格式:magic + 12B IV + GCM 密文 + 16B tag)。
 * 先写 <out>.tmp 再改名:失败绝不留下会被当成最新归档的半成品(评审 B4 中危)。
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

/** 读文件头判断归档版本(无 magic = v1 历史格式)。 */
const versionOf = (encPath: string): 'v1' | 'v2' => {
  const fd = openSync(encPath, 'r')
  const head = Buffer.alloc(V2_MAGIC.length)
  readSync(fd, head, 0, head.length, 0)
  closeSync(fd)
  return head.equals(V2_MAGIC) ? 'v2' : 'v1'
}

/**
 * 加密文件 → 明文文件。按 magic 自动分流:
 * - v2:密钥 = BACKUP_KEY 或 HKDF 派生;GCM 认证,篡改/密钥错一律抛错;
 * - v1:密钥 = legacy 派生,兼容线上既有归档。
 * 先写 `<out>.tmp` 再改名:解密中途失败(篡改/密钥错)绝不留下会被当成
 * 恢复成功的半成品目标文件(债务 R2 复查发现)。
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
      // v1(历史 CBC,无认证):密钥 = legacy 派生;密钥错/截断由 padding 抛错兜底
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
