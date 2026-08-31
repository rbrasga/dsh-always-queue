/**
 * Pending-queue store tests: FIFO order, per-session snapshots, remove/
 * takeBatch/requeue, and localStorage persistence (jsdom provides storage).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pendingStore } from '../src/client/pending-store.ts'

const STORAGE_KEY = 'dsh-always-queue:pending:v1'

beforeEach(() => {
  pendingStore.clear()
})

describe('add / entries', () => {
  it('appends in FIFO order', () => {
    const a = pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a' }] })
    const b = pendingStore.add({ sessionId: 'B', content: [{ type: 'text', text: 'b' }] })
    const a2 = pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a2' }] })
    expect(pendingStore.entries().map(e => e.id)).toEqual([a.id, b.id, a2.id])
    expect(pendingStore.head()?.id).toBe(a.id)
  })

  it('persists additions to localStorage', () => {
    pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a' }] })
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw as string)
    expect(stored).toHaveLength(1)
    expect(stored[0].sessionId).toBe('A')
    expect(stored[0].content).toEqual([{ type: 'text', text: 'a' }])
  })
})

describe('getSnapshotFor', () => {
  it('returns a stable identity per session between mutations', () => {
    pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a' }] })
    pendingStore.add({ sessionId: 'B', content: [{ type: 'text', text: 'b' }] })
    const a1 = pendingStore.getSnapshotFor('A')
    const a2 = pendingStore.getSnapshotFor('A')
    expect(a1).toBe(a2)
    expect(pendingStore.getSnapshotFor('B')).not.toBe(a1)
    expect(a1).toHaveLength(1)
    expect(pendingStore.getSnapshotFor('C')).toHaveLength(0)
  })

  it('invalidates cached snapshots on mutation', () => {
    const a1 = pendingStore.getSnapshotFor('A')
    expect(a1).toHaveLength(0)
    pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a' }] })
    const a2 = pendingStore.getSnapshotFor('A')
    expect(a2).not.toBe(a1)
    expect(a2).toHaveLength(1)
  })

  it('notifies subscribers on mutation', () => {
    const spy = vi.fn()
    const off = pendingStore.subscribe(spy)
    pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a' }] })
    expect(spy).toHaveBeenCalledTimes(1)
    pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'b' }] })
    expect(spy).toHaveBeenCalledTimes(2)
    off()
    pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'c' }] })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('remove / takeBatchFor / requeueFront', () => {
  it('removes one entry by id (idempotent)', () => {
    const a = pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a' }] })
    pendingStore.remove(a.id)
    expect(pendingStore.entries()).toHaveLength(0)
    pendingStore.remove(a.id)
    expect(pendingStore.entries()).toHaveLength(0)
  })

  it('takeBatchFor removes and returns one session entries only, in FIFO order', () => {
    const a1 = pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a1' }] })
    const b1 = pendingStore.add({ sessionId: 'B', content: [{ type: 'text', text: 'b1' }] })
    const a2 = pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a2' }] })
    const batch = pendingStore.takeBatchFor('A')
    expect(batch.map(e => e.id)).toEqual([a1.id, a2.id])
    expect(pendingStore.entries().map(e => e.id)).toEqual([b1.id])
  })

  it('requeueFront puts a failed entry back at the head with the new attempts count', () => {
    const a = pendingStore.add({ sessionId: 'A', content: [{ type: 'text', text: 'a' }] })
    const b = pendingStore.add({ sessionId: 'B', content: [{ type: 'text', text: 'b' }] })
    pendingStore.remove(a.id)
    pendingStore.requeueFront({ ...a, attempts: 3 })
    expect(pendingStore.entries().map(e => e.id)).toEqual([a.id, b.id])
    expect(pendingStore.entries()[0]?.attempts).toBe(3)
  })
})

describe('image content round-trip through storage', () => {
  it('preserves image parts across persist/reload', () => {
    pendingStore.add({
      sessionId: 'A',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'aGk=', name: 'x.png' },
        { type: 'text', text: 'with image' },
      ],
    })
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw as string)
    expect(stored[0].content[0]).toEqual({ type: 'image', mediaType: 'image/png', data: 'aGk=', name: 'x.png' })
  })
})

describe('rehydration (module load)', () => {
  it('restores a persisted queue and drops malformed entries', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: 'good', sessionId: 'S1', content: [{ type: 'text', text: 'hi' }], queuedAt: 123, attempts: 1 },
      { id: 'bad-session', sessionId: 42, content: [{ type: 'text', text: 'x' }], queuedAt: 0, attempts: 0 },
      { id: 'bad-content', sessionId: 'S2', content: [{ type: 'text' }], queuedAt: 0, attempts: 0 },
    ]))
    vi.resetModules()
    const fresh = await import('../src/client/pending-store.ts')
    const entries = fresh.pendingStore.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('good')
    expect(entries[0]?.attempts).toBe(1)
    expect(entries[0]?.content).toEqual([{ type: 'text', text: 'hi' }])
    fresh.pendingStore.clear()
  })
})
