import type { HistoryEvent } from '../gateway/client.js'

/**
 * Trimming a replayed transcript down to what the browser can actually use.
 *
 * A real session measured 429 events, 415 of them `chunk`. Chunks exist so a
 * reply can be drawn while it streams; on replay the `message` frame carries the
 * same text and is authoritative -- the client's reducer even clears the streamed
 * copy when a message lands. So the default history response was 96% payload
 * that gets built up and then thrown away.
 *
 * This is not paging. Paging hides old turns; this removes bytes that no longer
 * say anything, which is the cheaper fix and does not change what the reader can
 * see.
 */

const isChunk = (event: HistoryEvent): boolean => event.kind === 'chunk'

const chunkType = (event: HistoryEvent): string => {
  const chunk = event.chunk
  if (chunk === null || typeof chunk !== 'object') return ''
  const type = (chunk as { type?: unknown }).type
  return typeof type === 'string' ? type : ''
}

const chunkText = (event: HistoryEvent): string => {
  const chunk = event.chunk
  if (chunk === null || typeof chunk !== 'object') return ''
  const text = (chunk as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

/**
 * Splits a history into one segment per turn.
 *
 * `turn_end` closes a segment because that is where the client's reducer closes
 * an agent block. A trailing segment with no `turn_end` is a turn still in
 * flight and is returned as its own segment.
 */
const segments = (events: HistoryEvent[]): HistoryEvent[][] => {
  const out: HistoryEvent[][] = []
  let current: HistoryEvent[] = []
  for (const event of events) {
    current.push(event)
    if (event.kind === 'turn_end') {
      out.push(current)
      current = []
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Drops or merges the chunk events of one turn.
 *
 * A turn that produced a `message` has no use for its text chunks at all. A turn
 * that did not -- cancelled, timed out, stream dropped mid-reply -- has nothing
 * *but* chunks, and dropping them would erase the partial answer the user paid
 * for. So they are merged instead of discarded, and the turn still reads back the
 * way it looked on screen.
 *
 * Reasoning chunks are always merged rather than dropped. Nothing renders them
 * today, but that is a fact about the current UI, not a promise, and merging
 * costs one event either way.
 */
const compactSegment = (segment: HistoryEvent[]): HistoryEvent[] => {
  const hasMessage = segment.some((event) => event.kind === 'message')
  const merged = new Map<string, HistoryEvent>()
  const out: HistoryEvent[] = []

  for (const event of segment) {
    if (!isChunk(event)) {
      out.push(event)
      continue
    }
    const type = chunkType(event)
    if (type === 'text-delta' && hasMessage) continue

    const existing = merged.get(type)
    if (existing === undefined) {
      // The first chunk of its type keeps its position and seq; later ones fold
      // into it, so ordering relative to tool calls is preserved.
      const copy: HistoryEvent = { ...event, chunk: { type, text: chunkText(event) } }
      merged.set(type, copy)
      out.push(copy)
      continue
    }
    const chunk = existing.chunk as { type: string; text: string }
    chunk.text += chunkText(event)
  }

  return out
}

/** Compacts a replayed history. Live frames are untouched and never come here. */
export const compactHistory = (events: HistoryEvent[]): HistoryEvent[] =>
  segments(events).flatMap(compactSegment)
