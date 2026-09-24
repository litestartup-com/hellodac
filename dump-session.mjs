// 一次性诊断脚本：解压 .jsonl.zstd 会话日志（多帧）并打印事件序列。
// 用法: node dump-session.mjs <session.jsonl.zstd 路径>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node dump-session.mjs <file>')
  process.exit(1)
}
const buf = readFileSync(file)

// zstd 帧扫描：与 dsh-session-persistence-jsonl/src/zstd.ts scanZstdFrames 同款
// （魔数 + 帧头 + 3 字节 block 头逐个跳帧）。
function scanFrames(b) {
  const frames = []
  let offset = 0
  while (offset < b.length) {
    const start = offset
    if (b.length - offset < 4) return { frames, consumed: offset, torn: start }
    if (b.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    const descriptor = b.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (b.length - offset < 3) return { frames, consumed: offset, torn: start }
      const blockHeader = b.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (b.length - offset < payloadBytes) return { frames, consumed: offset, torn: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push(b.subarray(start, offset))
  }
  return { frames, consumed: offset, torn: 0 }
}

const { frames, consumed } = scanFrames(buf)
console.log(`frames: ${frames.length}, consumed: ${consumed}/${buf.length}`)
let count = 0
for (const f of frames) {
  const text = zstdDecompressSync(f).toString('utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let ev
    try { ev = JSON.parse(line) } catch { console.log(`<unparseable ${line.slice(0, 80)}>`); continue }
    count += 1
    const brief = { t: ev.time ?? null, type: ev.type, seq: ev.seq }
    if (ev.type === 'question/asked' || ev.type === 'question/answered') brief.q = JSON.stringify(ev.data ?? ev).slice(0, 200)
    if (ev.type === 'approval/requested' || ev.type === 'approval/decided' || ev.type === 'permission/request') brief.d = JSON.stringify(ev.data ?? ev).slice(0, 200)
    if (ev.type === 'permission/preset' || ev.type === 'approval/policy' || ev.type === 'sandbox/mode') brief.d = JSON.stringify(ev.data ?? ev).slice(0, 300)
    if (ev.type === 'tool/call') brief.name = ev.data?.name ?? '?'
    if (ev.type === 'user/message') brief.text = JSON.stringify((ev.data?.content ?? '')).slice(0, 90)
    if (ev.type === 'assistant/message') brief.text = JSON.stringify((ev.data?.message?.content ?? '')).slice(0, 90)
    if (ev.type === 'tool/result') brief.r = JSON.stringify(ev.data ?? ev).slice(0, 600)
    if (ev.type === 'turn/end') brief.end = JSON.stringify(ev.data ?? ev).slice(0, 300)
    console.log(JSON.stringify(brief))
  }
}
console.log(`total events: ${count}`)
