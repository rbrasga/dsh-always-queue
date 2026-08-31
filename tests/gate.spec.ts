/**
 * Pure gate decision tests: the single-in-progress rule and the release-batch
 * selection share this truth with the wiring (src/client/index.ts).
 */
import { describe, expect, it } from 'vitest'
import { decideGate, hasImages, previewOf, releaseBatch } from '../src/client/gate.ts'
import type { PendingEntry } from '../src/client/pending-store.ts'

function entry(id: string, sessionId: string, content: PendingEntry['content'] = [], queuedAt = 0): PendingEntry {
  return { id, sessionId, content, queuedAt, attempts: 0 }
}

describe('decideGate', () => {
  it('passes through when the target session is itself running (in-session queue/steer preserved)', () => {
    expect(decideGate({ targetRunning: true, otherBusy: true })).toBe('pass')
    expect(decideGate({ targetRunning: true, otherBusy: false })).toBe('pass')
  })

  it('holds an idle target while another session is busy', () => {
    expect(decideGate({ targetRunning: false, otherBusy: true })).toBe('hold')
  })

  it('passes an idle target through when nothing else is busy', () => {
    expect(decideGate({ targetRunning: false, otherBusy: false })).toBe('pass')
  })
})

describe('releaseBatch', () => {
  it('returns an empty batch for an empty queue', () => {
    expect(releaseBatch([])).toEqual([])
  })

  it('returns the head session entries only, in FIFO order', () => {
    const b1 = entry('b1', 'B', [{ type: 'text', text: 'first' }], 1)
    const c1 = entry('c1', 'C', [{ type: 'text', text: 'other' }], 2)
    const b2 = entry('b2', 'B', [{ type: 'text', text: 'second' }], 3)
    const c2 = entry('c2', 'C', [{ type: 'text', text: 'other2' }], 4)
    expect(releaseBatch([b1, c1, b2, c2])).toEqual([b1, b2])
  })

  it('treats a whole queue of one session as one batch', () => {
    const b1 = entry('b1', 'B')
    const b2 = entry('b2', 'B')
    expect(releaseBatch([b1, b2])).toEqual([b1, b2])
  })
})

describe('previewOf / hasImages', () => {
  it('returns the first text part as the preview', () => {
    expect(previewOf({ content: [{ type: 'image', mediaType: 'image/png', data: 'aGk=' }, { type: 'text', text: 'hello' }] })).toBe('hello')
  })

  it('returns an empty preview for image-only entries', () => {
    expect(previewOf({ content: [{ type: 'image', mediaType: 'image/png', data: 'aGk=' }] })).toBe('')
  })

  it('detects image parts', () => {
    expect(hasImages({ content: [{ type: 'text', text: 'x' }] })).toBe(false)
    expect(hasImages({ content: [{ type: 'text', text: 'x' }, { type: 'image', mediaType: 'image/png', data: 'aGk=' }] })).toBe(true)
  })
})
