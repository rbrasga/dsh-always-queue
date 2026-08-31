/**
 * Gate wiring tests: the internal/get interception of the conversation
 * service plus the FIFO release loop, against a fake cordis context.
 *
 * Simulates the user's scenario end to end: session A running, new sessions
 * B and C held on send, then — as A completes — B's batch releases (and its
 * running flag keeps C held) and finally C releases.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { apply, inject } from '../src/client/index.ts'
import { pendingStore } from '../src/client/pending-store.ts'

// The wiring test never renders the dock, but index.ts pulls in dock.tsx which
// value-imports the primitives package (an external not installed here). Stub
// it exactly like the dock component test does so the module graph resolves.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => (
    <span data-tip={label}>{children}</span>
  ),
  IconRightUpOutline16: () => <span data-icon="pull" />,
  IconTrashOutline16: () => <span data-icon="remove" />,
}))

/** Flush microtasks (the release loop is an async IIFE). */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

interface FakeSummary { id: string; displayTitle: string; running: boolean; blank: boolean; updatedAt: number }
interface FakeList {
  ids: string[]
  byId: Record<string, FakeSummary>
  current: string | undefined
  phase: 'pending' | 'ready'
}

interface Harness {
  list: FakeList
  setList: (next: FakeList) => void
  resolve: (name: string) => unknown
  notify: ReturnType<typeof vi.fn>
  sentSessions: { sessionId: string; text: string; imageIds: string[]; mode: string }[]
  sentPlains: string[]
  serialized: string[][]
  released: string[]
  prompts: { sessionId: string; content: unknown[]; mode: string }[]
  sessionFaces: Map<string, { sessionId: string; prompt: ReturnType<typeof vi.fn> }>
  callerCtxs: Map<object, string>
}

function makeHarness(list: FakeList): Harness {
  const h: Harness = {
    list,
    setList: () => {},
    resolve: () => {},
    notify: vi.fn(),
    sentSessions: [],
    sentPlains: [],
    serialized: [],
    released: [],
    prompts: [],
    sessionFaces: new Map(),
    callerCtxs: new Map(),
  }

  // --- fake session faces (one per listed session).
  for (const id of list.ids) {
    h.sessionFaces.set(id, {
      sessionId: id,
      prompt: vi.fn(async (content: unknown[], mode: string) => {
        h.prompts.push({ sessionId: id, content, mode })
        return { ok: true, value: { accepted: true } }
      }),
    })
  }

  // --- fake list snapshot store.
  let state = list
  const subs = new Set<() => void>()
  h.setList = (next) => {
    state = next
    for (const fn of [...subs]) fn()
  }
  const listStore = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } },
  }

  // --- fake caller contexts (for the plain send scope resolution).
  const callerCtxs = h.callerCtxs
  for (const id of list.ids) {
    callerCtxs.set({ __ctx: id }, id)
  }

  // --- fake conversation service.
  const conversation = {
    ctx: undefined as unknown, // set per reading context below
    input: {
      for: (_actx: unknown) => ({ notify: (level: string, text: string) => { h.notify(level, text) } }),
    },
    blocks: { set: () => {} },
    send: vi.fn(async (text: string) => { h.sentPlains.push(text) }),
    sendSession: vi.fn(async (session: { sessionId: string }, text: string, imageIds: string[], mode: string) => {
      h.sentSessions.push({ sessionId: session.sessionId, text, imageIds, mode })
      return { kind: 'success' }
    }),
    serializeDraftImages: vi.fn(async (ids: string[]) => {
      h.serialized.push(ids)
      return ids.map(id => ({ mediaType: 'image/png' as const, data: `data-${id}` }))
    }),
    releaseDraftImage: vi.fn((id: string) => { h.released.push(id) }),
  }

  // --- fake services + waterfall.
  const services: Record<string, unknown> = {
    sessions: {
      list: listStore,
      scope: (id: string) => ({ __actx: id }),
      scopeOf: (ctx: unknown) => callerCtxs.get(ctx as object),
      binding: (id: string) => {
        // Mirrors the harness: a binding resolves for a session that is
        // currently listed (removed sessions drop their binding).
        if (state.byId[id] === undefined) return undefined
        const face = h.sessionFaces.get(id)
        if (face === undefined) return undefined
        return { sessionId: id, session: face, ctx: {} }
      },
    },
    conversation,
    locale: {
      register: () => {},
      bind: () => (key: string, params?: Record<string, unknown>) =>
        key.replace('{n}', String(params?.n ?? '')),
    },
  }

  const getListeners = new Set<(ctx: unknown, name: string, error: Error, next: () => unknown) => unknown>()
  h.resolve = (name: string) => {
    let index = 0
    const next = (): unknown => {
      const listener = [...getListeners][index++]
      if (listener === undefined) return services[name]
      return listener({}, name, new Error('get'), next)
    }
    return next()
  }

  const ctx = {
    effect: (fn: () => (() => void) | void, _label?: string) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    },
    on: (event: string, listener: (ctx: unknown, name: string, error: Error, next: () => unknown) => unknown) => {
      if (event === 'internal/get') getListeners.add(listener)
      return () => { if (event === 'internal/get') getListeners.delete(listener) }
    },
    get: (key: string) => services[key],
    sessions: services.sessions,
    locale: services.locale,
    slots: {
      inject: () => () => {},
      register: () => () => {},
    },
  }

  const effectCleanups: (() => void)[] = []
  void effectCleanups

  apply(ctx as never)
  return h
}

function listWith(running: Record<string, boolean>, phase: 'pending' | 'ready' = 'ready'): FakeList {
  const ids = Object.keys(running)
  const byId: Record<string, FakeSummary> = {}
  for (const id of ids) {
    byId[id] = { id, displayTitle: id, running: running[id] ?? false, blank: false, updatedAt: 1 }
  }
  return { ids, byId, current: ids[0], phase }
}

beforeEach(() => {
  pendingStore.clear()
})

describe('gate wiring', () => {
  it('declares the service injects', () => {
    expect(inject).toEqual(expect.arrayContaining(['slots', 'locale', 'sessions', 'conversation']))
  })

  it('holds idle-session sends while another session runs, then releases FIFO', async () => {
    const h = makeHarness(listWith({ A: true, B: false, C: false }))
    const wrapped = h.resolve('conversation') as {
      sendSession(session: { sessionId: string }, text: string, imageIds: string[], mode: string): Promise<unknown>
    }

    // A is running: sends to idle B and C are held; the original is untouched.
    const r1 = await wrapped.sendSession({ sessionId: 'B' }, 'hello B', [], 'queue')
    expect(r1).toEqual({ kind: 'success' })
    const r2 = await wrapped.sendSession({ sessionId: 'C' }, 'hello C', [], 'queue')
    expect(r2).toEqual({ kind: 'success' })
    expect(h.sentSessions).toEqual([])
    expect(h.prompts).toEqual([])
    expect(pendingStore.entries().map(e => [e.sessionId, e.content])).toEqual([
      ['B', [{ type: 'text', text: 'hello B' }]],
      ['C', [{ type: 'text', text: 'hello C' }]],
    ])
    expect(h.notify).toHaveBeenCalledWith('info', 'queued')

    // A send to the RUNNING session passes through with its mode intact.
    await wrapped.sendSession({ sessionId: 'A' }, 'steer A', [], 'steer')
    expect(h.sentSessions).toEqual([{ sessionId: 'A', text: 'steer A', imageIds: [], mode: 'steer' }])
    expect(h.prompts).toEqual([])

    // A completes: B's batch releases first, C stays held.
    h.setList(listWith({ A: false, B: false, C: false }))
    await flush()
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toEqual({ sessionId: 'B', content: [{ type: 'text', text: 'hello B' }], mode: 'queue' })
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['C'])

    // The release guard holds a fresh send until B's running flag lands.
    await wrapped.sendSession({ sessionId: 'A' }, 'again to A', [], 'queue')
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['C', 'A'])

    // B's flag lands: nothing releases yet (B is running).
    h.setList(listWith({ A: false, B: true, C: false }))
    await flush()
    expect(h.prompts).toHaveLength(1)

    // B completes: C releases (then A would release next).
    h.setList(listWith({ A: false, B: false, C: false }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B', 'C'])
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['A'])

    // A's turn: the earlier "again to A" message releases last.
    h.setList(listWith({ A: false, B: false, C: true }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B', 'C'])
    h.setList(listWith({ A: false, B: false, C: false }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B', 'C', 'A'])
    expect(pendingStore.entries()).toEqual([])
  })

  it('passes everything through when no session runs', async () => {
    const h = makeHarness(listWith({ B: false }))
    const wrapped = h.resolve('conversation') as {
      sendSession(session: { sessionId: string }, text: string, imageIds: string[], mode: string): Promise<unknown>
    }
    await wrapped.sendSession({ sessionId: 'B' }, 'go', [], 'queue')
    expect(h.sentSessions).toEqual([{ sessionId: 'B', text: 'go', imageIds: [], mode: 'queue' }])
    expect(pendingStore.entries()).toEqual([])
  })

  it('passes through while the list is still pending (first load race)', async () => {
    const h = makeHarness(listWith({ B: false }, 'pending'))
    const wrapped = h.resolve('conversation') as {
      sendSession(session: { sessionId: string }, text: string, imageIds: string[], mode: string): Promise<unknown>
    }
    await wrapped.sendSession({ sessionId: 'B' }, 'early', [], 'queue')
    expect(h.sentSessions).toEqual([{ sessionId: 'B', text: 'early', imageIds: [], mode: 'queue' }])
    expect(pendingStore.entries()).toEqual([])
  })

  it('holds a plain scoped send and resolves the caller scope via the ctx property', async () => {
    const h = makeHarness(listWith({ A: true, B: false }))
    const conversation = h.resolve('conversation') as { ctx: object; send(text: string): Promise<unknown> }
    const callerCtx = [...h.callerCtxs].find(([, id]) => id === 'B')?.[0]
    if (callerCtx === undefined) throw new Error('no caller ctx for B')
    conversation.ctx = callerCtx
    await conversation.send('scoped to B')
    expect(h.sentPlains).toEqual([])
    expect(pendingStore.entries().map(e => [e.sessionId, e.content])).toEqual([
      ['B', [{ type: 'text', text: 'scoped to B' }]],
    ])
  })

  it('captures and releases draft images when holding an image send', async () => {
    const h = makeHarness(listWith({ A: true, B: false }))
    const wrapped = h.resolve('conversation') as {
      sendSession(session: { sessionId: string }, text: string, imageIds: string[], mode: string): Promise<unknown>
    }
    await wrapped.sendSession({ sessionId: 'B' }, 'with images', ['i1', 'i2'], 'queue')
    expect(h.serialized).toEqual([['i1', 'i2']])
    expect(h.released).toEqual(['i1', 'i2'])
    const entry = pendingStore.entries()[0]
    expect(entry?.content).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'data-i1' },
      { type: 'image', mediaType: 'image/png', data: 'data-i2' },
      { type: 'text', text: 'with images' },
    ])
    // Release delivers the captured image parts.
    h.setList(listWith({ A: false, B: false }))
    await flush()
    expect(h.prompts[0]?.content).toEqual(entry?.content)
  })

  it('drops held entries whose session vanished before release', async () => {
    const h = makeHarness(listWith({ A: true, B: false, GONE: false }))
    const wrapped = h.resolve('conversation') as {
      sendSession(session: { sessionId: string }, text: string, imageIds: string[], mode: string): Promise<unknown>
    }
    await wrapped.sendSession({ sessionId: 'GONE' }, 'ghost', [], 'queue')
    // GONE disappears from the host list while A is still running.
    h.setList(listWith({ A: true, B: false }))
    await flush()
    expect(h.prompts).toEqual([])
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['GONE'])
    // A completes: the ghost entry is dropped (no binding), nothing sent.
    h.setList(listWith({ A: false, B: false }))
    await flush()
    expect(h.prompts).toEqual([])
    expect(pendingStore.entries()).toEqual([])
  })
})
