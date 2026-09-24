// 债务 F1:chat.js 拆分第五步——state 层(asks:问答/授权卡片的开合状态机)。
//
// track 是纯函数(帧 → Map 增删),与 trackAsks 原逻辑逐字一致,独立单测
// (chat-state.test.mjs);syncAsks 的 DOM 挂载仍在 chat.js(需要 askNode/el)。

/**
 * @returns {{
 *   track: (frame: any) => void;
 *   size: () => number;
 *   get: (id: string) => any;
 *   clear: () => void;
 *   entries: () => [string, any][];
 * }}
 */
export const makeAsks = () => {
  /**
   * What the agent is blocked on, by id, in arrival order.
   *
   * Kept outside `blocks` because these are not transcript: they are live state
   * the gateway opens and closes, and the reducer rebuilds `blocks` from scratch
   * on every frame. Cards live in their own persistent node for the same reason
   * the waiting indicator does -- a redraw mid-answer must not swallow the text
   * someone is typing into one.
   */
  const asks = new Map()

  /**
   * Open and close cards from the gateway's own frames.
   *
   * Closing is driven by `question_resolved` / `approval_resolved` rather than by
   * the click that sent the answer, so a card that someone else answered first --
   * another tab, or the turn being cancelled -- disappears here too.
   */
  const track = (frame) => {
    switch (frame.kind) {
      case 'question_asked':
        if (typeof frame.questionId === 'string' && Array.isArray(frame.questions)) {
          asks.set(frame.questionId, { kind: 'question', id: frame.questionId, questions: frame.questions })
        }
        return
      case 'approval_pending':
        if (typeof frame.decisionId === 'string') {
          asks.set(frame.decisionId, {
            kind: 'approval',
            id: frame.decisionId,
            approvalId: typeof frame.approvalId === 'string' ? frame.approvalId : null,
            toolName: typeof frame.toolName === 'string' ? frame.toolName : '',
            reason: typeof frame.reason === 'string' ? frame.reason : null,
          })
        }
        return
      case 'question_resolved':
        asks.delete(frame.questionId)
        return
      case 'approval_resolved':
        if (typeof frame.decisionId === 'string') {
          asks.delete(frame.decisionId)
        } else if (typeof frame.approvalId === 'string') {
          // The resolved frame names the approvalId, not the original rpcId; a
          // fresh mux connection may not have seen the request, so fall back to
          // scanning cards by approvalId.
          for (const [key, value] of asks) {
            if (value.kind === 'approval' && value.approvalId === frame.approvalId) asks.delete(key)
          }
        }
        return
      case 'turn_end':
      case 'turn_done':
        // Nothing can be answered once the turn is over, and a card left behind
        // would take an answer nobody is waiting for.
        asks.clear()
        return
      default:
        return
    }
  }

  return {
    track,
    size: () => asks.size,
    get: (id) => asks.get(id),
    clear: () => asks.clear(),
    entries: () => [...asks.entries()],
  }
}
