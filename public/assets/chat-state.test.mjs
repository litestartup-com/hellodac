// 债务 F1:chat-state asks 状态机测试——question/approval 卡片的开合语义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAsks } from './chat-state.js'

const setup = () => makeAsks()

test('债务 F1: question_asked 建卡,question_resolved 按 questionId 关卡', () => {
  const { track, size } = setup()
  track({ kind: 'question_asked', questionId: 'q1', questions: [{ id: 'a', question: '哪个?' }] })
  assert.equal(size(), 1)
  track({ kind: 'question_resolved', questionId: 'q1' })
  assert.equal(size(), 0)
})

test('债务 F1: approval_pending 建卡并记 approvalId', () => {
  const { track, get } = setup()
  track({ kind: 'approval_pending', decisionId: 'd1', approvalId: 'ap-1', toolName: 'write', reason: '危险' })
  assert.deepEqual(get('d1'), { kind: 'approval', id: 'd1', approvalId: 'ap-1', toolName: 'write', reason: '危险' })
})

test('债务 F1: approval_resolved 无 decisionId 时按 approvalId 扫描关卡(重连未见请求帧)', () => {
  const { track, size } = setup()
  track({ kind: 'approval_pending', decisionId: 'd1', approvalId: 'ap-9', toolName: 'write', reason: null })
  track({ kind: 'approval_resolved', approvalId: 'ap-9' })
  assert.equal(size(), 0)
})

test('债务 F1: approval_resolved 带 decisionId 直接关卡', () => {
  const { track, size } = setup()
  track({ kind: 'approval_pending', decisionId: 'd1', approvalId: 'ap-1', toolName: 'write', reason: null })
  track({ kind: 'approval_resolved', decisionId: 'd1', approvalId: 'ap-1' })
  assert.equal(size(), 0)
})

test('债务 F1: turn_end/turn_done 清空全部卡片(回合结束无人等答案)', () => {
  const { track, size } = setup()
  track({ kind: 'question_asked', questionId: 'q1', questions: [] })
  track({ kind: 'approval_pending', decisionId: 'd1', approvalId: 'ap-1', toolName: 'x', reason: null })
  track({ kind: 'turn_end' })
  assert.equal(size(), 0)
})

test('债务 F1: 畸形帧不建卡(缺 questionId/decisionId 或 questions 非数组)', () => {
  const { track, size } = setup()
  track({ kind: 'question_asked', questions: [] })
  track({ kind: 'question_asked', questionId: 'q2', questions: 'not-array' })
  track({ kind: 'approval_pending', approvalId: 'ap-1', toolName: 'x', reason: null })
  assert.equal(size(), 0)
})

test('债务 F1: 同一 questionId 重复到达覆盖旧卡(id 幂等)', () => {
  const { track, size, get } = setup()
  track({ kind: 'question_asked', questionId: 'q1', questions: [{ id: 'a', question: '旧' }] })
  track({ kind: 'question_asked', questionId: 'q1', questions: [{ id: 'b', question: '新' }] })
  assert.equal(size(), 1)
  assert.equal(get('q1').questions[0].question, '新')
})
