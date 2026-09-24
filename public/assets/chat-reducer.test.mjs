// 债务 F1:chat-reducer 纯函数测试——reducer 是「转录只有一种画法」的核心,
// 拆出 chat.js 前先用测试把行为钉死(红→绿),再让 chat.js 引用它。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useTestDictionary } from './test-i18n.mjs'

useTestDictionary('en')

const { newAgentBlock, reduce, attachRuns, build } = await import('./chat-reducer.js')

test('债务 F1: chunk 在无 turn_start 时也开 agent block(恢复会话不承诺 turn_start)', () => {
  const list = reduce([], { kind: 'chunk', chunk: { type: 'text-delta', text: '你好' } })
  assert.equal(list.length, 1)
  assert.equal(list[0].role, 'agent')
  assert.equal(list[0].streamed, '你好')
  assert.equal(list[0].streaming, true)
})

test('债务 F1: message 帧是权威——流式预览被替换而非拼接', () => {
  let list = reduce([], { kind: 'chunk', chunk: { type: 'text-delta', text: '预览' } })
  list = reduce(list, { kind: 'message', text: '最终', reasoning: '', usage: null })
  assert.equal(list[0].text, '最终')
  assert.equal(list[0].streamed, '')
  assert.equal(list[0].streaming, false)
})

test('债务 F1: 多条 message 帧按顺序追加,usage 求和', () => {
  let list = reduce([], { kind: 'message', text: '前半', usage: { inputTokens: 10, outputTokens: 5 } })
  list = reduce(list, { kind: 'message', text: '后半', usage: { inputTokens: 0, outputTokens: 3 } })
  assert.equal(list[0].text, '前半后半')
  assert.deepEqual(list[0].usage, { inputTokens: 10, outputTokens: 8, reasoningTokens: 0 })
})

test('债务 F1: 系统注入折叠——<system-reminder> 包裹或前一条已是 user 都算注入', () => {
  let list = reduce([], { kind: 'user', text: '真问题' })
  list = reduce(list, { kind: 'user', text: '<system-reminder>上下文</system-reminder>' })
  assert.equal(list[1].injected, true)
  list = reduce(list, { kind: 'user', text: '另一条' })
  assert.equal(list[2].injected, true, '前一条是 user 时后续 user 视为注入')
})

test('债务 F1: tool_result 按到达顺序配给最新未完成调用;失败与文本落位', () => {
  let list = reduce([], { kind: 'tool_call', name: 'write', arguments: '{"path":"a.txt"}' })
  list = reduce(list, { kind: 'tool_call', name: 'read', arguments: '{}' })
  list = reduce(list, { kind: 'tool_result', isError: true, text: 'boom' })
  assert.equal(list[0].tools[0].done, false)
  assert.equal(list[0].tools[1].done, true)
  assert.equal(list[0].tools[1].failed, true)
  assert.equal(list[0].tools[1].resultText, 'boom')
})

test('债务 F1: tool_call 落 path/write 判定(路径键多种拼写)', () => {
  const list = reduce([], { kind: 'tool_call', name: 'edit_file', arguments: '{"file_path":"b.md"}' })
  assert.equal(list[0].tools[0].path, 'b.md')
  assert.equal(list[0].tools[0].write, true)
})

test('债务 F1: turn_end error/aborted 的文案与 detail 提取', () => {
  let list = reduce([], { kind: 'turn_end', reason: 'error', detail: { message: '炸了' } })
  assert.equal(list[0].error, '炸了')
  list = reduce([], { kind: 'turn_end', reason: 'aborted', detail: { cause: 'user_cancelled' } })
  assert.equal(list[0].error, 'cancelled')
  list = reduce([], { kind: 'turn_end', reason: 'aborted', detail: { cause: 'timeout' } })
  assert.equal(list[0].error, 'the turn was interrupted')
})

test('债务 F1: turn_done 在无 turn_end 时兜底收尾(超时/断流)', () => {
  let list = reduce([], { kind: 'chunk', chunk: { type: 'text-delta', text: 'x' } })
  list = reduce(list, { kind: 'turn_done', runId: 'r1', state: 'failed', error: '超时' })
  assert.equal(list[0].reason, 'error')
  assert.equal(list[0].runId, 'r1')
  assert.equal(list[0].runState, 'failed')
  assert.equal(list[0].error, '超时')
})

test('债务 F1: approval_asked/decided 只切 awaiting,不动转录', () => {
  let list = reduce([], { kind: 'approval_asked', toolName: 'write', reason: '危险' })
  assert.deepEqual(list[0].awaiting, { toolName: 'write', reason: '危险' })
  list = reduce(list, { kind: 'approval_decided' })
  assert.equal(list[0].awaiting, null)
})

test('债务 F1: attachRuns 数量不符时不猜——整体放弃挂账', () => {
  const list = reduce([], { kind: 'message', text: 'x', usage: null })
  const runs = [{ id: 'a' }, { id: 'b' }]
  const out = attachRuns(list, runs)
  assert.equal(out[0].run, undefined, '数量对不上时不得错位挂账')
})

test('债务 F1: attachRuns 数量一致时按位置挂账并回填 runId/runState/error', () => {
  const list = reduce([], { kind: 'message', text: 'x', usage: null })
  const runs = [{ id: 'a', state: 'done', error: 'boom', usage: null }]
  const out = attachRuns(list, runs)
  assert.equal(out[0].run.id, 'a')
  assert.equal(out[0].runId, 'a')
  assert.equal(out[0].runState, 'done')
  assert.equal(out[0].error, 'boom')
})

test('债务 F1: build = 逐帧 reduce + attachRuns', () => {
  const blocks = build(
    [
      { kind: 'user', text: 'hi' },
      { kind: 'message', text: 'yo', usage: null },
    ],
    [{ id: 'r1', state: 'done', error: null, usage: null }],
  )
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].role, 'user')
  assert.equal(blocks[1].run.id, 'r1')
})

test('债务 F1: newAgentBlock 初始形状(awaiting/usage/reason 全空)', () => {
  const b = newAgentBlock()
  assert.deepEqual(b, {
    role: 'agent', text: '', streamed: '', streaming: false, reasoning: '', tools: [],
    usage: null, reason: null, error: null, runId: null, runState: null, awaiting: null,
  })
})
