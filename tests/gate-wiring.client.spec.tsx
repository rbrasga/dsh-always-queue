/**
 * Gate wiring tests: the instance-level interception of the conversation
 * service plus the FIFO release loop and claims, against a fake cordis
 * context.
 *
 * Simulates the user's scenario end to end: session A running, new sessions
 * B and C held on send, then — as A completes — B's batch releases (and its
 * claim, then running flag, keeps C held) and finally C releases. Also
 * covers the flag-landing race (claims), steer pass-through, and
 * re-provision re-patching.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { apply, inject } from '../src/client/index.ts'
import { pendingStore } from '../src/client/pending-store.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => (
    <span data-tip={label}>{children}</span>
  ),
  IconRightUpOutline16: () => <span data-icon="pull" />,
  IconTrashOutline16: () => <span data-icon="remove" />,
}))

/** Flush microtasks (the release loop is an async IIFE). */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Cordis symbols (global registry — same identity the harness uses). */
const ORIGINAL = Symbol.for('cordis.original')
const GATED = Symbol.for('dsh-always-queue.gated')

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
  /** The traceable-style face the plugin (and the test) read services through. */
  face: {
    send(text: string): Promise<unknown>
    sendSession(
      session: { sessionId: string },
      text: string,
      imageIds: string[],
      mode: string,
    ): Promise<unknown>
  }
  raw: Record<PropertyKey, unknown>
  notify: ReturnType<typeof vi.fn>
  sentSessions: { sessionId: string; text: string; imageIds: string[]; mode: string }[]
  sentPlains: string[]
  serialized: string[][]
  released: string[]
  prompts: { sessionId: string; content: unknown[]; mode: string }[]
  sessionFaces: Map<string, { sessionId: string; prompt: ReturnType<typeof vi.fn> }>
  /** Set the caller context the next plain send's shadow resolves. */
  setCallerCtx: (ctx: unknown) => void
  callerCtxs: Map<object, string>
  /** Fire the internal/service event with a (re)provisioned value. */
  emitService: (name: string, value: unknown) => void
}

function makeHarness(initialList: FakeList): Harness {
  const h: Harness = {
    list: initialList,
    setList: () => {},
    face: {
      send: async () => {},
      sendSession: async () => {},
    },
    raw: {},
    notify: vi.fn(),
    sentSessions: [],
    sentPlains: [],
    serialized: [],
    released: [],
    prompts: [],
    sessionFaces: new Map(),
    setCallerCtx: () => {},
    callerCtxs: new Map(),
    emitService: () => {},
  }

  // --- fake session faces (one per listed session).
  for (const id of initialList.ids) {
    h.sessionFaces.set(id, {
      sessionId: id,
      prompt: vi.fn(async (content: unknown[], mode: string) => {
        h.prompts.push({ sessionId: id, content, mode })
        return { ok: true, value: { accepted: true } }
      }),
    })
  }

  // --- fake list snapshot store.
  let state = initialList
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
  for (const id of initialList.ids) {
    h.callerCtxs.set({ __ctx: id }, id)
  }
  h.setCallerCtx = (ctx: unknown) => { callerCtx = ctx }

  // --- raw conversation service instance.
  const raw: Record<PropertyKey, unknown> = {
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
      return ids.map(id => ({ mediaType: 'image/png' as const, data: 'data-' + id }))
    }),
    releaseDraftImage: vi.fn((id: string) => { h.released.push(id) }),
  }
  h.raw = raw

  // --- minimal traceable face: ORIGINAL escape hatch, per-caller ctx
  //     rebinding on function calls, sets forwarded to the raw instance.
  let callerCtx: unknown
  const shadow = new Proxy(raw, {
    get: (t, p, r) => (p === 'ctx' ? callerCtx : Reflect.get(t, p, r)),
  })
  const face = new Proxy(raw, {
    get: (t, p, r) => {
      if (p === ORIGINAL) return t
      const v = Reflect.get(t, p, r)
      if (typeof v === 'function') return (...args: unknown[]) => v.apply(shadow, args)
      return v
    },
    set: (t, p, v) => { (t as Record<PropertyKey, unknown>)[p] = v; return true },
  })
  h.face = face as Harness['face']

  // --- fake services.
  const sessionsService = {
    list: listStore,
    scope: (id: string) => ({ __actx: id }),
    scopeOf: (ctx: unknown) => callerCtxsOf.get(ctx),
    binding: (id: string) => {
      // Mirrors the harness: a binding resolves for a session that is
      // currently listed (removed sessions drop their binding).
      if (state.byId[id] === undefined) return undefined
      const face2 = h.sessionFaces.get(id)
      if (face2 === undefined) return undefined
      return { sessionId: id, session: face2, ctx: {} }
    },
  }
  const callerCtxsOf = h.callerCtxs
  const localeService = {
    register: () => {},
    bind: () => (key: string, params?: Record<string, unknown>) =>
      key.replace('{n}', String(params?.n ?? '')),
  }

  // --- fake client context.
  const serviceListeners: ((name: string, value: unknown) => void)[] = []
  h.emitService = (name, value) => {
    for (const listener of [...serviceListeners]) listener(name, value)
  }
  const effectCleanups: (() => void)[] = []
  const ctx = {
    effect: (fn: () => (() => void) | void, _label?: string) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      if (event === 'internal/service') serviceListeners.push(listener as (n: string, v: unknown) => void)
      return () => {}
    },
    get: (key: string) => (key === 'conversation' ? face : undefined),
    sessions: sessionsService,
    locale: localeService,
    slots: {
      inject: () => () => {},
      register: () => () => {},
    },
  }

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

  it('patches the raw instance through the cordis original symbol', () => {
    const h = makeHarness(listWith({ B: false }))
    expect(h.raw.sendSession).toBeTypeOf('function')
    expect((h.raw.sendSession as Record<PropertyKey, unknown>)[GATED]).toBeTruthy()
    expect(h.raw.send).toBeTypeOf('function')
    expect((h.raw.send as Record<PropertyKey, unknown>)[GATED]).toBeTruthy()
  })

  it('holds idle-session sends while another session runs, then releases FIFO', async () => {
    const h = makeHarness(listWith({ A: true, B: false, C: false }))

    // A is running: sends to idle B and C are held; the original is untouched.
    const r1 = await h.face.sendSession({ sessionId: 'B' }, 'hello B', [], 'queue')
    expect(r1).toEqual({ kind: 'success' })
    const r2 = await h.face.sendSession({ sessionId: 'C' }, 'hello C', [], 'queue')
    expect(r2).toEqual({ kind: 'success' })
    expect(h.sentSessions).toEqual([])
    expect(h.prompts).toEqual([])
    expect(pendingStore.entries().map(e => [e.sessionId, e.content])).toEqual([
      ['B', [{ type: 'text', text: 'hello B' }]],
      ['C', [{ type: 'text', text: 'hello C' }]],
    ])
    expect(h.notify).toHaveBeenCalledWith('info', 'queued')

    // A send to the RUNNING session passes through with its mode intact.
    await h.face.sendSession({ sessionId: 'A' }, 'steer A', [], 'steer')
    expect(h.sentSessions).toEqual([{ sessionId: 'A', text: 'steer A', imageIds: [], mode: 'steer' }])
    expect(h.prompts).toEqual([])

    // A completes: B's batch releases first; the release claim keeps C held
    // until B's running flag lands.
    h.setList(listWith({ A: false, B: false, C: false }))
    await flush()
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toEqual({ sessionId: 'B', content: [{ type: 'text', text: 'hello B' }], mode: 'queue' })
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['C'])

    // The claim holds a fresh send until B's running flag lands.
    await h.face.sendSession({ sessionId: 'A' }, 'again to A', [], 'queue')
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['C', 'A'])

    // B's flag lands: the claim retires, B's flag keeps C and A held.
    h.setList(listWith({ A: false, B: true, C: false }))
    await flush()
    expect(h.prompts).toHaveLength(1)

    // B completes: C releases (then A would release next).
    h.setList(listWith({ A: false, B: false, C: false }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B', 'C'])
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['A'])

    // C's flag lands.
    h.setList(listWith({ A: false, B: false, C: true }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B', 'C'])

    // C completes: A's earlier message releases last.
    h.setList(listWith({ A: false, B: false, C: false }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B', 'C', 'A'])
    expect(pendingStore.entries()).toEqual([])
  })

  it('passes everything through when no session runs', async () => {
    const h = makeHarness(listWith({ B: false }))
    await h.face.sendSession({ sessionId: 'B' }, 'go', [], 'queue')
    expect(h.sentSessions).toEqual([{ sessionId: 'B', text: 'go', imageIds: [], mode: 'queue' }])
    expect(pendingStore.entries()).toEqual([])
  })

  it('passes through while the list is still pending (first load race)', async () => {
    const h = makeHarness(listWith({ B: false }, 'pending'))
    await h.face.sendSession({ sessionId: 'B' }, 'early', [], 'queue')
    expect(h.sentSessions).toEqual([{ sessionId: 'B', text: 'early', imageIds: [], mode: 'queue' }])
    expect(pendingStore.entries()).toEqual([])
  })

  it('holds a plain scoped send and resolves the caller scope via the ctx property', async () => {
    const h = makeHarness(listWith({ A: true, B: false }))
    const callerCtx = [...h.callerCtxs].find(([, id]) => id === 'B')?.[0]
    if (callerCtx === undefined) throw new Error('no caller ctx for B')
    h.setCallerCtx(callerCtx)
    await h.face.send('scoped to B')
    expect(h.sentPlains).toEqual([])
    expect(pendingStore.entries().map(e => [e.sessionId, e.content])).toEqual([
      ['B', [{ type: 'text', text: 'scoped to B' }]],
    ])
  })

  it('captures and releases draft images when holding an image send', async () => {
    const h = makeHarness(listWith({ A: true, B: false }))
    await h.face.sendSession({ sessionId: 'B' }, 'with images', ['i1', 'i2'], 'queue')
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
    await h.face.sendSession({ sessionId: 'GONE' }, 'ghost', [], 'queue')
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

  it('claims close the flag-landing race on a normal start', async () => {
    const h = makeHarness(listWith({ B: false, C: false }))
    // B starts: the pass-through claims it before the host flag lands...
    await h.face.sendSession({ sessionId: 'B' }, 'first', [], 'queue')
    expect(h.sentSessions).toEqual([{ sessionId: 'B', text: 'first', imageIds: [], mode: 'queue' }])
    // ...so a send to C in the gap is held (the list still shows B idle).
    await h.face.sendSession({ sessionId: 'C' }, 'second', [], 'queue')
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['C'])
    // B's flag lands: the claim retires, the flag keeps C held.
    h.setList(listWith({ B: true, C: false }))
    await flush()
    expect(h.prompts).toEqual([])
    // B completes: C releases.
    h.setList(listWith({ B: false, C: false }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['C'])
    expect(pendingStore.entries()).toEqual([])
  })

  it('lets a steer to an idle session pass through while another runs', async () => {
    const h = makeHarness(listWith({ A: true, B: false }))
    await h.face.sendSession({ sessionId: 'B' }, 'steer to idle', [], 'steer')
    expect(h.sentSessions).toEqual([{ sessionId: 'B', text: 'steer to idle', imageIds: [], mode: 'steer' }])
    expect(pendingStore.entries()).toEqual([])
  })

  it('re-provision re-patches exactly once (idempotent via the gated marker)', async () => {
    const h = makeHarness(listWith({ A: true, B: false }))
    const firstWrapper = h.raw.sendSession
    // The same instance re-provisioned: no double wrap.
    h.emitService('conversation', h.raw)
    expect(h.raw.sendSession).toBe(firstWrapper)
    // A brand-new instance: patched on the event.
    const fresh: Record<PropertyKey, unknown> = {
      send: async () => {},
      sendSession: async () => ({ kind: 'success' }),
    }
    h.emitService('conversation', fresh)
    expect(fresh.sendSession).not.toBe(async () => ({ kind: 'success' }))
    expect((fresh.sendSession as Record<PropertyKey, unknown>)[GATED]).toBeTruthy()
    // Unrelated services are ignored.
    h.emitService('settings', { other: true })
    expect(h.raw.sendSession).toBe(firstWrapper)
  })
})
