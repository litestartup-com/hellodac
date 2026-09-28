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

describe('Debt A4: nextReconnectDelay exponential backoff + jitter', () => {
  it('attempt 1 = 3s base, backoff grows, capped at 30s', () => {
    for (let i = 0; i < 50; i += 1) {
      assert.ok(nextReconnectDelay(1) >= 2_250 && nextReconnectDelay(1) <= 3_750, 'first attempt 3s ±25%')
      assert.ok(nextReconnectDelay(2) >= 4_500 && nextReconnectDelay(2) <= 7_500, 'second attempt 6s ±25%')
      assert.ok(nextReconnectDelay(3) >= 9_000 && nextReconnectDelay(3) <= 15_000, 'third attempt 12s ±25%')
      assert.ok(nextReconnectDelay(10) >= 22_500 && nextReconnectDelay(10) <= 37_500, 'base capped at 30s, jitter adds no more than +25%')
    }
  })
})

/**
 * A hand-written fake WebSocket: only the surface mux uses (onopen/onmessage/onerror/onclose + close).
 * The connection factory is injected through _setSocketFactory, so no real network is involved.
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

describe('Debt A4: connection-level behaviour (fake socket injected)', () => {
  it('after a successful reconnect, stream_reconnected is broadcast to every active subscriber (not on the first connect)', async () => {
    // Debt C3: a mock clock drives the reconnect backoff, removing the real 4.1s wait.
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
      captured[0]!.onopen?.() // first connect
      assert.deepEqual(seen, [], 'the first connect does not broadcast stream_reconnected')

      captured[0]!.close() // disconnect -> reconnect after the backoff
      // Let the onclose microtask through first (that is what schedules the reconnect timer), then advance the clock
      await Promise.resolve()
      // The first backoff = 3s ±25% jitter, so it can stretch to 3750ms -- advancing 4s covers every case
      // (@types/node types tick as void although it returns a Promise -- wrapping it silences the false report)
      await Promise.resolve(mock.timers.tick(4_000))
      assert.equal(captured.length, 2, 'a disconnect must trigger an automatic reconnect')
      captured[1]!.onopen?.() // reconnect succeeded
      assert.deepEqual(seen, ['stream_reconnected'], 'a successful reconnect must broadcast stream_reconnected')
    } finally {
      unsub()
      mock.timers.reset()
    }
  })

  it('Debt R5: a failed first connect (never onopen) does not count as "was connected" -- the successful retry must not broadcast stream_reconnected', async () => {
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
      captured[0]!.close() // the first connect closes before ever calling onopen (connection failed/refused)
      await Promise.resolve() // let the onclose microtask through, scheduling the reconnect timer
      await Promise.resolve(mock.timers.tick(4_000)) // the automatic reconnect after the backoff
      assert.equal(captured.length, 2, 'a disconnect must trigger an automatic reconnect')
      captured[1]!.onopen?.() // the retry's first successful connection
      assert.deepEqual(seen, [], 'first connect failed then the retry succeeded: must not broadcast stream_reconnected (it would kill the run by mistake)')
    } finally {
      unsub()
      mock.timers.reset()
    }
  })

  it('Debt R5: the first connect succeeded and then the line dropped -- a successful reconnect must still broadcast stream_reconnected', async () => {
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
      captured[0]!.onopen?.() // first connect succeeded
      captured[0]!.close() // disconnect
      await Promise.resolve() // let the onclose microtask through, scheduling the reconnect timer
      await Promise.resolve(mock.timers.tick(4_000))
      assert.equal(captured.length, 2)
      captured[1]!.onopen?.()
      assert.deepEqual(seen, ['stream_reconnected'], 'it had connected before, so a successful reconnect must broadcast')
    } finally {
      unsub()
      mock.timers.reset()
    }
  })

  it('unsubscribe fix: an old unsub called after re-subscribing must not delete the new subscription', () => {    captured.length = 0
    _setSocketFactory(() => {
      const ws = new FakeWs()
      captured.push(ws)
      return ws as unknown as WebSocket
    })

    const got: Array<{ listener: string; kind: string }> = []
    // A resident subscription keeps conn alive after s1 unsubscribes -- the precondition for reproducing the
    // original bug (within one connection: unsubscribe -> resubscribe -> the old unsub runs late and deletes the new set from the map).
    const keepalive = subscribe(EP, 's-keep', () => {})
    const unsubOld = subscribe(EP, 's1', (_sid, frame) => got.push({ listener: 'old', kind: frame.kind }))
    unsubOld()
    const unsubNew = subscribe(EP, 's1', (_sid, frame) => got.push({ listener: 'new', kind: frame.kind }))
    // the old unsub runs again (order: unsubscribe -> resubscribe -> the old unsub runs late)
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
    assert.ok(kinds.includes('new:turn_start'), 'the new subscription must still be in effect')
    assert.ok(!kinds.some((k) => k.startsWith('old:')), 'the old subscription must be removed completely')

    unsubNew()
    keepalive()
  })

  it('Debt card chain: a rejected question/requested frame with the wrong shape must leave a log line (the clue for diagnosing cards that never show)', () => {
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
          // missing the questions field -- the schema must reject it; the old behaviour dropped it silently, leaving a card that never shows with nothing to investigate
          payload: { type: 'question/requested', sessionId: 's1' },
        }),
      })
      assert.ok(logLines.some((l) => l.includes('dropped frame') && l.includes('question/requested')), `a drop must leave a trace: ${logLines.join(' | ')}`)
    } finally {
      unsub()
      setMuxLogger(() => {})
    }
  })

  it('Debt card chain: a reconnect after a disconnect must leave a trace (subscribed chat count) -- the tool for locating a lost broadcast window', async () => {
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
      captured[0]!.onopen?.() // first connect (no reconnect log)
      assert.ok(!logLines.some((l) => l.includes('reconnected')), 'the first connect must not log reconnected')
      captured[0]!.close() // disconnect
      await Promise.resolve()
      await Promise.resolve(mock.timers.tick(4_000))
      captured[1]!.onopen?.() // reconnect succeeded
      assert.ok(logLines.some((l) => l.includes('connection lost')), `a disconnect must leave a trace: ${logLines.join(' | ')}`)
      assert.ok(logLines.some((l) => l.includes('reconnected')), `a reconnect must leave a trace: ${logLines.join(' | ')}`)
    } finally {
      unsub()
      setMuxLogger(() => {})
      mock.timers.reset()
    }
  })
})
