import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decryptFile, deriveLegacyBackupKey, encryptFile } from './crypt.js'

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'

const plainText = (): string => 'hello world '.repeat(20)

/**
 * Debt A1: backup encryption goes from CBC (unauthenticated) to GCM.
 * The red proof = decrypting must fail once one byte of the IV is tampered with: under the old CBC an IV change
 * only corrupts the first block, while the padding in the last block is untouched -> decryption "succeeds" and emits garbage (a red test).
 */
test('Debt A1 regression: a tampered IV must fail to decrypt (GCM authentication)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypt-'))
  const plain = join(dir, 'plain.txt')
  writeFileSync(plain, plainText(), 'utf8')
  const enc = join(dir, 'out.enc')
  await encryptFile(plain, enc, SECRET)

  // Tamper with the IV area (the old v1 layout has the IV at 0-15; the new v2 layout has it after the magic (8B)) -- offset 10 is inside the IV in both
  const fd = openSync(enc, 'r+')
  const b = Buffer.alloc(1)
  readSync(fd, b, 0, 1, 10)
  writeSync(fd, Buffer.from([(b[0] ?? 0) ^ 0xff]), 0, 1, 10)
  closeSync(fd)

  const out = join(dir, 'out.txt')
  await assert.rejects(
    () => decryptFile(enc, out, SECRET),
    /./,
    'a tampered archive must fail to decrypt; silently decoding altered data is never allowed',
  )
})

test('Debt A1 regression: a tampered authentication tag must fail to decrypt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypt-tag-'))
  const plain = join(dir, 'plain.txt')
  writeFileSync(plain, plainText(), 'utf8')
  const enc = join(dir, 'out.enc')
  await encryptFile(plain, enc, SECRET)

  // Flip the last byte (v2 = the tail of the authTag; v1 = the last block of ciphertext)
  const size = readFileSync(enc).length
  const fd = openSync(enc, 'r+')
  const b = Buffer.alloc(1)
  readSync(fd, b, 0, 1, size - 1)
  writeSync(fd, Buffer.from([(b[0] ?? 0) ^ 0xff]), 0, 1, size - 1)
  closeSync(fd)

  await assert.rejects(() => decryptFile(enc, join(dir, 'out.txt'), SECRET), /./)
})

/** Build an old-format archive by hand with the v1 algorithm (16B IV + CBC ciphertext, legacy derived key) -- to imitate the backups already out there. */
const makeV1Archive = (dir: string, content: string): string => {
  const enc = join(dir, 'v1.enc')
  const legacyKey = deriveLegacyBackupKey(SECRET)
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', legacyKey, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(content, 'utf8')), cipher.final()])
  writeFileSync(enc, Buffer.concat([iv, ct]))
  return enc
}

test('Debt A1 regression: an old v1 archive (CBC) still decrypts -- the upgrade does not break the recovery chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypt-v1-'))
  const enc = makeV1Archive(dir, 'legacy archive content')
  const out = join(dir, 'out.txt')
  await decryptFile(enc, out, SECRET)
  assert.equal(readFileSync(out, 'utf8'), 'legacy archive content')
})

test('Debt A1 regression: v2 encrypt -> decrypt round-trips identically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypt-rt-'))
  const plain = join(dir, 'plain.txt')
  writeFileSync(plain, plainText(), 'utf8')
  const enc = join(dir, 'out.enc')
  await encryptFile(plain, enc, SECRET)
  const out = join(dir, 'out.txt')
  await decryptFile(enc, out, SECRET)
  assert.equal(readFileSync(out, 'utf8'), plainText())
})
