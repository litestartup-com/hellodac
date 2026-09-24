// 债务 F1:chat-wire 帧分发与缓冲对账测试——wire 层下沉前先钉死行为。
//
// handleFrame 是 live stream 的核心:loading 期间缓冲、turn_queued 进 dock、
// goal 直落状态、turn_start 移队、turn_done 触发 reload。用假 refs 直接驱动,
// 不碰 EventSource/DOM。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWire, alreadyLoaded } from './chat-wire.js'

const box = (init) => {
  let value = init
  return {
    get value() { return value },
    set value(v) { value = v },
  }
}

const makeRefs = () => ({
  state: box(null),
  pendingUserTexts: box([]),
  queuedItems: box([]),
  blocks: box([]),
  sending: box(false),
  turnStartedAt: box(null),
  modelChoices: box(new Map()),
  modelCatalogSessionId: box(null),
  buffered: box([]),
  loading: box(false),
})

/** 只实现 handleFrame 需要面的假 deps。 */
const makeDeps = (refs) => {
  const calls = { render: 0, reload: 0, loadModels: 0, loadDelegations: 0 }
  const wire = makeWire(refs, {
    render: () => { calls.render += 1 },
    reload: () => { calls.reload += 1 },
    loadModels: () => { calls.loadModels += 1 },
    loadDelegations: () => { calls.loadDelegations += 1 },
    trackAsks: () => {},
    reduce: (list, frame) => (frame.kind === 'chunk' ? [{ kind: 'chunk', text: frame.chunk.text }] : list),
    uniqueFrames: (list) => list,
    build: (events) => events.map((e) => ({ kind: e.kind })),
    fatal: () => {},
    renderDelegations: () => {},
  })
  return { wire, calls }
}

test('债务 F1: hello/composer_state/delegation_done 不进转录', () => {
  const refs = makeRefs()
  refs.state.value = { composer: {} }
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'hello' })
  wire.handleFrame({ kind: 'composer_state', accessMode: 'read-only' })
  wire.handleFrame({ kind: 'delegation_done' })
  assert.equal(refs.blocks.value.length, 0)
  assert.equal(calls.loadDelegations, 1, 'delegation_done 触发派工重拉')
  assert.equal(calls.render, 1, 'composer_state 触发重绘')
})

test('债务 F1: loading 期间帧进缓冲,不碰转录', () => {
  const refs = makeRefs()
  refs.loading.value = true
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'chunk', chunk: { text: 'x' } })
  wire.handleFrame({ kind: 'turn_queued', id: 'q1', text: 'y' })
  assert.equal(refs.blocks.value.length, 0)
  assert.equal(refs.buffered.value.length, 2)
  assert.equal(calls.render, 0)
})

test('债务 F1: 空闲时 turn_queued 直接进 dock 并重绘', () => {
  const refs = makeRefs()
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'turn_queued', id: 'q1', text: '排队消息' })
  assert.deepEqual(refs.queuedItems.value.map((q) => q.text), ['排队消息'])
  assert.equal(calls.render, 1)
})

test('债务 F1: turn_start 把 dock 队首移进 pendingUserTexts', () => {
  const refs = makeRefs()
  refs.queuedItems.value = [{ id: 'q1', text: '排队消息', at: 1 }]
  const { wire } = makeDeps(refs)
  wire.handleFrame({ kind: 'turn_start' })
  assert.equal(refs.queuedItems.value.length, 0)
  assert.equal(refs.pendingUserTexts.value.length, 1)
  assert.equal(refs.turnStartedAt.value !== null, true, 'turn_start 时补记起始时间')
})

test('债务 F1: goal 帧直落 state.goal,不进 blocks', () => {
  const refs = makeRefs()
  refs.state.value = {}
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'goal', goal: { id: 'g1', objective: '上线', phase: 'active' } })
  assert.equal(refs.state.value.goal.id, 'g1')
  assert.equal(refs.blocks.value.length, 0)
  assert.equal(calls.render, 1)
})

test('债务 F1: turn_done 清 sending/时钟并触发 reload', () => {
  const refs = makeRefs()
  refs.sending.value = true
  refs.turnStartedAt.value = 1000
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'turn_done', state: 'done' })
  assert.equal(refs.sending.value, false)
  assert.equal(refs.turnStartedAt.value, null)
  assert.equal(calls.reload, 1)
})

test('债务 F1: 普通帧 fold 进转录并重绘', () => {
  const refs = makeRefs()
  const { wire, calls } = makeDeps(refs)
  wire.handleFrame({ kind: 'chunk', chunk: { text: 'hello' } })
  assert.equal(refs.blocks.value.length, 1)
  assert.equal(calls.render, 1)
})

test('债务 F1: alreadyLoaded 按 seq 去重,user 回显按文本比对', () => {
  const list = [{ role: 'user', text: '你好' }]
  assert.equal(alreadyLoaded({ kind: 'chunk', seq: 5 }, 9, list), true, 'seq ≤ maxSeq 算已加载')
  assert.equal(alreadyLoaded({ kind: 'chunk', seq: 11 }, 9, list), false)
  assert.equal(alreadyLoaded({ kind: 'user', text: '你好' }, 9, list), true, '同文本 user 回显算已加载')
  assert.equal(alreadyLoaded({ kind: 'user', text: '不同' }, 9, list), false)
  assert.equal(alreadyLoaded({ kind: 'turn_done' }, 9, list), false, '无 seq 的 manager 帧可安全重放')
})
