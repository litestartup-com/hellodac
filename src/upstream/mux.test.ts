import { after, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { parseMuxFrame, muxUrl, subscribe, nextReconnectDelay, closeAllMux, _setSocketFactory, setMuxLogger, type MuxListener } from './mux.js'
import type { UpstreamEndpoint } from './rpc.js'

const EP: UpstreamEndpoint = { base: 'http://127.0.0.1:3080/api', key: '' }

describe('muxUrl', () => {
  it('derives the WebSocket endpoint from an http base', () => {
    assert.equal(muxUrl('http://127.0.0.1:3080/api'), 'ws://127.0.0.1:3080/api/events.mux')
  })

  it('derives wss from https', () => {
    assert.equal(muxUrl('https://host.example/api'), 'wss://host.example/api/events.mux')
  })
})

describe('parseMuxFrame', () => {
  it('parses a server-request envelope', () => {
    const env = parseMuxFrame(JSON.stringify({
      type: 'server-request',
      rpcId: 'rpc-1',
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 's1', event: { type: 'turn/start', seq: 1, time: 0, data: {} } },
    }))
    assert.ok(env)
    assert.equal(env.type, 'server-request')
    assert.equal(env.rpcId, 'rpc-1')
    assert.equal(env.method, 'session/event')
    assert.equal(env.payload.sessionId, 's1')
  })

  it('returns null for server-response envelopes (wrong direction)', () => {
    assert.equal(parseMuxFrame(JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: null } })), null)
  })

  it('returns null for non-objects and malformed JSON', () => {
    assert.equal(parseMuxFrame('not json'), null)
    assert.equal(parseMuxFrame('"a string"'), null)
    assert.equal(parseMuxFrame('null'), null)
  })

  it('returns null when payload is missing', () => {
    assert.equal(parseMuxFrame(JSON.stringify({ type: 'server-request', rpcId: 'x', method: 'session/event' })), null)
  })
})

describe('债务 A4: nextReconnectDelay 指数退避 + 抖动', () => {
  it('attempt 1 = 3s 基数,退避递增,30s 封顶', () => {
    for (let i = 0; i < 50; i += 1) {
      assert.ok(nextReconnectDelay(1) >= 2_250 && nextReconnectDelay(1) <= 3_750, '首次 3s ±25%')
      assert.ok(nextReconnectDelay(2) >= 4_500 && nextReconnectDelay(2) <= 7_500, '二次 6s ±25%')
      assert.ok(nextReconnectDelay(3) >= 9_000 && nextReconnectDelay(3) <= 15_000, '三次 12s ±25%')
      assert.ok(nextReconnectDelay(10) >= 22_500 && nextReconnectDelay(10) <= 37_500, '基数封顶 30s,抖动上浮不超 ±25%')
    }
  })
})

/**
 * 手写假 WebSocket:只实现 mux 用到的面(onopen/onmessage/onerror/onclose + close)。
 * 连接工厂经 _setSocketFactory 注入,避免真实网络。
 */
class FakeWs {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  close(): void {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => this.onclose?.())
  }
}

const captured: FakeWs[] = []
after(() => {
  _setSocketFactory(() => {
    throw new Error('factory should not be used after tests')
  })
  closeAllMux()
})

describe('债务 A4: 连接级行为(注入假 socket)', () => {
  it('重连成功后向所有活跃订阅者广播 stream_reconnected(首连不发)', async () => {
    // 债务 C3:mock 时钟驱动重连退避,消掉 4.1s 真实等待。
    mock.timers.enable({ apis: ['setTimeout'] })
    captured.length = 0
    _setSocketFactory(() => {
      const ws = new FakeWs()
      captured.push(ws)
      return ws as unknown as WebSocket
    })

    const seen: string[] = []
    const listener: MuxListener = (_sid, frame) => {
      seen.push(frame.kind)
    }
    const unsub = subscribe(EP, 's1', listener)
    try {
      assert.equal(captured.length, 1)
      captured[0]!.onopen?.() // 首连
      assert.deepEqual(seen, [], '首连不广播 stream_reconnected')

      captured[0]!.close() // 断线 → 退避后重连
      // 先放行 onclose 微任务(它才排上重连定时器),再推时钟
      await Promise.resolve()
      // 首退避 = 3s ±25% 抖动,上浮可达 3750ms——推进 4s 覆盖全部余量
      // (@types/node 把 tick 标成 void,实际返回 Promise——包一层消除误报)
      await Promise.resolve(mock.timers.tick(4_000))
      assert.equal(captured.length, 2, '断线后必须自动重连')
      captured[1]!.onopen?.() // 重连成功
      assert.deepEqual(seen, ['stream_reconnected'], '重连成功必须广播 stream_reconnected')
    } finally {
      unsub()
      mock.timers.reset()
    }
  })

  it('债务 R5:首连失败(从未 onopen)不算「曾连接」——重试首次成功不得广播 stream_reconnected', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    captured.length = 0
    _setSocketFactory(() => {
      const ws = new FakeWs()
      captured.push(ws)
      return ws as unknown as WebSocket
    })

    const seen: string[] = []
    const unsub = subscribe(EP, 's1', (_sid, frame) => {
      seen.push(frame.kind)
    })
    try {
      assert.equal(captured.length, 1)
      captured[0]!.close() // 首连从未 onopen 就断线(连接失败/被拒)
      await Promise.resolve() // 放行 onclose 微任务,排上重连定时器
      await Promise.resolve(mock.timers.tick(4_000)) // 退避后的自动重连
      assert.equal(captured.length, 2, '断线后必须自动重连')
      captured[1]!.onopen?.() // 重试的首次成功连接
      assert.deepEqual(seen, [], '首连失败→重试首次成功,不得广播 stream_reconnected(会误杀 run)')
    } finally {
      unsub()
      mock.timers.reset()
    }
  })

  it('债务 R5:首连成功后断线,重连成功仍必须广播 stream_reconnected', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    captured.length = 0
    _setSocketFactory(() => {
      const ws = new FakeWs()
      captured.push(ws)
      return ws as unknown as WebSocket
    })

    const seen: string[] = []
    const unsub = subscribe(EP, 's1', (_sid, frame) => {
      seen.push(frame.kind)
    })
    try {
      assert.equal(captured.length, 1)
      captured[0]!.onopen?.() // 首连成功
      captured[0]!.close() // 断线
      await Promise.resolve() // 放行 onclose 微任务,排上重连定时器
      await Promise.resolve(mock.timers.tick(4_000))
      assert.equal(captured.length, 2)
      captured[1]!.onopen?.()
      assert.deepEqual(seen, ['stream_reconnected'], '曾连接过→重连成功必须广播')
    } finally {
      unsub()
      mock.timers.reset()
    }
  })

  it('退订修复:旧 unsub 在重新订阅之后调用,不得误删新订阅', () => {    captured.length = 0
    _setSocketFactory(() => {
      const ws = new FakeWs()
      captured.push(ws)
      return ws as unknown as WebSocket
    })

    const got: Array<{ listener: string; kind: string }> = []
    // 常驻订阅让 conn 在 s1 退订后仍然存活——原 bug 的复现前提(同一连接内
    // 退订→重订阅→旧 unsub 迟到执行,旧 unsub 会把新 set 从 map 误删)。
    const keepalive = subscribe(EP, 's-keep', () => {})
    const unsubOld = subscribe(EP, 's1', (_sid, frame) => got.push({ listener: 'old', kind: frame.kind }))
    unsubOld()
    const unsubNew = subscribe(EP, 's1', (_sid, frame) => got.push({ listener: 'new', kind: frame.kind }))
    // 旧 unsub 再来一次(时序:退订→重订阅→旧 unsub 迟到执行)
    unsubOld()

    const ws = captured[0]!
    ws.onopen?.()
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'server-request',
        rpcId: 'rpc-1',
        method: 'session/event',
        payload: { type: 'session/event', sessionId: 's1', event: { type: 'turn/start', seq: 1, time: 0, data: {} } },
      }),
    })
    const kinds = got.map((g) => `${g.listener}:${g.kind}`)
    assert.ok(kinds.includes('new:turn_start'), '新订阅必须仍然生效')
    assert.ok(!kinds.some((k) => k.startsWith('old:')), '旧订阅必须彻底移除')

    unsubNew()
    keepalive()
  })

  it('债务卡片链: 形状不符的 question/requested 帧被拒时必须留日志(卡片不显示的排障线索)', () => {
    captured.length = 0
    _setSocketFactory(() => {
      const ws = new FakeWs()
      captured.push(ws)
      return ws as unknown as WebSocket
    })
    const logLines: string[] = []
    setMuxLogger((line) => logLines.push(line))
    const unsub = subscribe(EP, 's1', () => {})
    try {
      const ws = captured[0]!
      ws.onopen?.()
      ws.onmessage?.({
        data: JSON.stringify({
          type: 'server-request',
          rpcId: 'rpc-9',
          method: 'question/requested',
          // 缺 questions 字段——schema 必拒;旧行为静默丢弃,卡片不显示且无从排查
          payload: { type: 'question/requested', sessionId: 's1' },
        }),
      })
      assert.ok(logLines.some((l) => l.includes('dropped frame') && l.includes('question/requested')), `丢弃必须留痕: ${logLines.join(' | ')}`)
    } finally {
      unsub()
      setMuxLogger(() => {})
    }
  })

  it('债务卡片链: 断线重连必须留痕(订阅会话数)——定位「广播窗口丢失」用', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    captured.length = 0
    _setSocketFactory(() => {
      const ws = new FakeWs()
      captured.push(ws)
      return ws as unknown as WebSocket
    })
    const logLines: string[] = []
    setMuxLogger((line) => logLines.push(line))
    const unsub = subscribe(EP, 's1', () => {})
    try {
      captured[0]!.onopen?.() // 首连(不记重连日志)
      assert.ok(!logLines.some((l) => l.includes('reconnected')), '首连不得记 reconnected')
      captured[0]!.close() // 断线
      await Promise.resolve()
      await Promise.resolve(mock.timers.tick(4_000))
      captured[1]!.onopen?.() // 重连成功
      assert.ok(logLines.some((l) => l.includes('connection lost')), `断线必须留痕: ${logLines.join(' | ')}`)
      assert.ok(logLines.some((l) => l.includes('reconnected')), `重连必须留痕: ${logLines.join(' | ')}`)
    } finally {
      unsub()
      setMuxLogger(() => {})
      mock.timers.reset()
    }
  })
})
