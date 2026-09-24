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
 * 债务 A1:备份加密从 CBC(无认证)升级 GCM。
 * 红证 = 篡改 IV 一字节后解密必须失败:旧 CBC 下 IV 篡改只污染第一个
 * block、padding 在最后 block 不受影响 → 解密"成功"输出垃圾(测试红)。
 */
test('债务 A1 回归: 篡改 IV 必须解密失败(GCM 认证)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypt-'))
  const plain = join(dir, 'plain.txt')
  writeFileSync(plain, plainText(), 'utf8')
  const enc = join(dir, 'out.enc')
  await encryptFile(plain, enc, SECRET)

  // 篡改 IV 区(旧 v1 布局 IV 在 0-15;新 v2 布局 IV 在 magic(8B)之后)——offset 10 两边都在 IV 内
  const fd = openSync(enc, 'r+')
  const b = Buffer.alloc(1)
  readSync(fd, b, 0, 1, 10)
  writeSync(fd, Buffer.from([(b[0] ?? 0) ^ 0xff]), 0, 1, 10)
  closeSync(fd)

  const out = join(dir, 'out.txt')
  await assert.rejects(
    () => decryptFile(enc, out, SECRET),
    /./,
    '篡改后的归档必须解密失败,绝不允许静默解出被改过的数据',
  )
})

test('债务 A1 回归: 篡改认证标签必须解密失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypt-tag-'))
  const plain = join(dir, 'plain.txt')
  writeFileSync(plain, plainText(), 'utf8')
  const enc = join(dir, 'out.enc')
  await encryptFile(plain, enc, SECRET)

  // 翻转最后一个字节(v2 = authTag 尾部;v1 = 密文最后 block)
  const size = readFileSync(enc).length
  const fd = openSync(enc, 'r+')
  const b = Buffer.alloc(1)
  readSync(fd, b, 0, 1, size - 1)
  writeSync(fd, Buffer.from([(b[0] ?? 0) ^ 0xff]), 0, 1, size - 1)
  closeSync(fd)

  await assert.rejects(() => decryptFile(enc, join(dir, 'out.txt'), SECRET), /./)
})

/** 用 v1 算法手工构造旧格式归档(16B IV + CBC 密文,legacy 派生密钥)——模拟线上既有备份物。 */
const makeV1Archive = (dir: string, content: string): string => {
  const enc = join(dir, 'v1.enc')
  const legacyKey = deriveLegacyBackupKey(SECRET)
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', legacyKey, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(content, 'utf8')), cipher.final()])
  writeFileSync(enc, Buffer.concat([iv, ct]))
  return enc
}

test('债务 A1 回归: v1 旧归档(CBC)仍可解密——升级不打断恢复链', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypt-v1-'))
  const enc = makeV1Archive(dir, 'legacy archive content')
  const out = join(dir, 'out.txt')
  await decryptFile(enc, out, SECRET)
  assert.equal(readFileSync(out, 'utf8'), 'legacy archive content')
})

test('债务 A1 回归: v2 加密 → 解密往返一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypt-rt-'))
  const plain = join(dir, 'plain.txt')
  writeFileSync(plain, plainText(), 'utf8')
  const enc = join(dir, 'out.enc')
  await encryptFile(plain, enc, SECRET)
  const out = join(dir, 'out.txt')
  await decryptFile(enc, out, SECRET)
  assert.equal(readFileSync(out, 'utf8'), plainText())
})
