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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

interface FakeSummary { id: string; displayTitle: string; running: boolean; blank: boolean; updatedAt: number; title?: string }

/** One fake session face: prompt/rename verbs plus the harness-internal engagement fields. */
interface FakeSessionFace {
  sessionId: string
  prompt: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
  promptAttempted: boolean
  blankBit: boolean
  firstPromptPendingTurn: boolean
  options: { onEngaged: ReturnType<typeof vi.fn> }
  notifier: { markDirty: ReturnType<typeof vi.fn> }
}
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
  sessionFaces: Map<string, FakeSessionFace>
  renames: { sessionId: string; title: string }[]
  /** The fake sessions service (exposes refresh() for the stuck-gate watchdog). */
  sessions: { refresh: ReturnType<typeof vi.fn> }
  /** Set the caller context the next plain send's shadow resolves. */
  setCallerCtx: (ctx: unknown) => void
  callerCtxs: Map<object, string>
  /** Fire the internal/service event with a (re)provisioned value. */
  emitService: (name: string, value: unknown) => void
  /** Run the fiber effect cleanups (clears the plugin's timers). */
  dispose: () => void
}

/** The harness under test (disposed in afterEach to clear plugin timers). */
let activeHarness: Harness | undefined

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
    renames: [],
    sessions: { refresh: undefined as unknown as ReturnType<typeof vi.fn> },
    setCallerCtx: () => {},
    callerCtxs: new Map(),
    emitService: () => {},
    dispose: () => {},
  }

  // --- fake session faces (one per listed session): prompt + rename plus
  //     the harness-internal engagement fields the plugin mirrors on hold.
  for (const id of initialList.ids) {
    h.sessionFaces.set(id, {
      sessionId: id,
      prompt: vi.fn(async (content: unknown[], mode: string) => {
        h.prompts.push({ sessionId: id, content, mode })
        return { ok: true, value: { accepted: true } }
      }),
      rename: vi.fn(async (title: string) => {
        h.renames.push({ sessionId: id, title })
        return { ok: true, value: { title, seq: 1 } }
      }),
      promptAttempted: false,
      blankBit: initialList.byId[id]?.blank ?? false,
      firstPromptPendingTurn: false,
      options: {
        // Emulates the harness: the 'engaged' mutation flips the row out of
        // blank (applyMutation case 'engaged') by REPLACING the summary —
        // captured snapshots keep their pre-flip identity — so a later
        // re-assert is a no-op unless a full refetch re-blanks the row.
        onEngaged: vi.fn((target: object) => {
          const sid = (target as { sessionId?: unknown }).sessionId
          if (typeof sid !== 'string') return
          const summary = state.byId[sid]
          if (summary === undefined || !summary.blank) return
          state.byId = { ...state.byId, [sid]: { ...summary, blank: false } }
        }),
      },
      notifier: { markDirty: vi.fn() },
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
    // Mirrors the concrete SessionRuntime method the stuck-gate watchdog
    // reaches for (best effort, outside the narrow contract face).
    refresh: vi.fn(async () => {}),
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
  h.sessions = { refresh: sessionsService.refresh }
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
  h.dispose = () => {
    for (const cleanup of effectCleanups.splice(0)) cleanup()
  }
  activeHarness = h
  return h
}

function listWith(
  running: Record<string, boolean>,
  phase: 'pending' | 'ready' = 'ready',
  blank: Record<string, boolean> = {},
): FakeList {
  const ids = Object.keys(running)
  const byId: Record<string, FakeSummary> = {}
  for (const id of ids) {
    byId[id] = { id, displayTitle: id, running: running[id] ?? false, blank: blank[id] ?? false, updatedAt: 1 }
  }
  return { ids, byId, current: ids[0], phase }
}

beforeEach(() => {
  pendingStore.clear()
})

afterEach(() => {
  activeHarness?.dispose()
  activeHarness = undefined
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
    // The hold notice names the gate holder (A runs; the fake locale t passes
    // the key through, so the {who} interpolation is the plugin's contract).
    expect(h.notify).toHaveBeenCalledWith('info', 'queued.by')

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

  it('force-resets a stuck release (prompt RPC that never settles) and delivers on a later poll', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(listWith({ A: true, B: false }))
      const face = h.sessionFaces.get('B')
      if (face === undefined) throw new Error('no face for B')
      // First prompt call hangs forever (dead connection — the RPC never
      // settles, so the release IIFE's finally-block never runs either).
      let calls = 0
      face.prompt = vi.fn((_c: readonly unknown[], _m: string) => {
        calls += 1
        if (calls === 1) return new Promise<never>(() => { /* never settles */ })
        h.prompts.push({ sessionId: 'B', content: [{ type: 'text', text: 'story' }], mode: _m })
        return Promise.resolve({ ok: true, value: { accepted: true } })
      })

      // Held while A runs.
      await h.face.sendSession({ sessionId: 'B' }, 'story', [], 'queue')
      expect(h.prompts).toHaveLength(0)

      // A completes: the release starts, its prompt call hangs → stuck.
      h.setList(listWith({ A: false, B: false }))
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)

      // Poll ticks (5 s cadence) skip while the release is "in flight"...
      await vi.advanceTimersByTimeAsync(5000 * 6)
      expect(calls).toBe(1)
      expect(h.prompts).toHaveLength(0)

      // ...until the stuck-release watchdog (30 s) trips on a tick:
      // force-reset, re-run the check, deliver.
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls).toBe(2)
      expect(h.prompts.map(p => p.sessionId)).toEqual(['B'])
      expect(pendingStore.entries()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
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

  it('engages a held blank session and gives it its provisional fallback title', async () => {
    const h = makeHarness(listWith(
      { A: true, B: false },
      'ready',
      { B: true },
    ))
    await h.face.sendSession({ sessionId: 'B' }, 'Write a fizz_buzz.py python script now', [], 'queue')
    expect(h.prompts).toEqual([])
    const b = h.sessionFaces.get('B')
    expect(b).toBeDefined()
    if (b === undefined) return
    // The harness-internal engagement mirror: the list row leaves blank, so
    // the New Session flow can mint a second session instead of reusing B.
    expect(b.promptAttempted).toBe(true)
    expect(b.blankBit).toBe(false)
    expect(b.firstPromptPendingTurn).toBe(true)
    expect(b.options.onEngaged).toHaveBeenCalledTimes(1)
    expect(b.notifier.markDirty).toHaveBeenCalled()
    // Provisional title: the same first-five-words fallback the host would
    // fold when the message releases (byte-identical, 40-byte cap honored).
    expect(h.renames).toEqual([{ sessionId: 'B', title: 'Write a fizz_buzz.py python script' }])
  })

  it('re-asserts the held session\'s un-blank after a full list refetch re-blanks it', async () => {
    const h = makeHarness(listWith(
      { A: true, B: false },
      'ready',
      { B: true },
    ))
    await h.face.sendSession({ sessionId: 'B' }, 'held first send here now', [], 'queue')
    const b = h.sessionFaces.get('B')
    expect(b).toBeDefined()
    if (b === undefined) return
    expect(b.blankBit).toBe(false)
    expect(b.options.onEngaged).toHaveBeenCalledTimes(1)

    // Simulate a full list refetch (the plugin's own stuck-gate watchdog
    // calls sessions.refresh): the harness replaces the host baseline — B is
    // blank again — and re-applies the host blank state to the Session,
    // dropping the one-shot 'engaged' mutation recorded at hold time.
    b.blankBit = true
    h.setList(listWith(
      { A: true, B: false },
      'ready',
      { B: true },
    ))
    await flush()

    // The list-change hook re-asserts: B's row leaves blank again, so the
    // New Session reuse scan cannot mistake the held session for a fresh
    // slot ("New Session does nothing").
    expect(b.blankBit).toBe(false)
    expect(b.firstPromptPendingTurn).toBe(true)
    expect(b.options.onEngaged).toHaveBeenCalledTimes(2)
    // The message is still held (A still runs): nothing was released.
    expect(h.prompts).toEqual([])
    expect(pendingStore.entries().map(e => e.sessionId)).toEqual(['B'])

    // A completes: B's batch releases (the held prompt is sent).
    h.setList(listWith({ A: false, B: false }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B'])
    // B's running flag lands (the host un-blanks for good): the id is
    // pruned, so later list changes never re-engage it (no spurious
    // 'engaged' mutations).
    h.setList(listWith({ A: false, B: true }))
    await flush()
    h.setList(listWith({ A: false, B: false }))
    await flush()
    expect(b.options.onEngaged).toHaveBeenCalledTimes(2)
  })

  it('does not re-assert sessions the plugin never engaged', async () => {
    const h = makeHarness(listWith(
      { A: true, B: false },
      'ready',
      { B: true },
    ))
    // No send to B: a refetch re-blank must not invent an engagement.
    h.setList(listWith(
      { A: true, B: false },
      'ready',
      { B: true },
    ))
    await flush()
    const b = h.sessionFaces.get('B')
    expect(b).toBeDefined()
    if (b === undefined) return
    expect(b.options.onEngaged).not.toHaveBeenCalled()
    expect(b.blankBit).toBe(true)
  })

  it('does not re-title a held target that is not blank or already titled', async () => {
    const h = makeHarness(listWith(
      { A: true, B: false, C: false },
      'ready',
      { C: true },
    ))
    h.list.byId['C']!.title = 'manual title'
    await h.face.sendSession({ sessionId: 'B' }, 'to B', [], 'queue')
    await h.face.sendSession({ sessionId: 'C' }, 'to C', [], 'queue')
    expect(h.renames).toEqual([])
    const b = h.sessionFaces.get('B')
    const c = h.sessionFaces.get('C')
    expect(b).toBeDefined()
    expect(c).toBeDefined()
    if (b === undefined || c === undefined) return
    // B is non-blank: engagement only mirrors promptAttempted, no flip.
    expect(b.promptAttempted).toBe(true)
    expect(b.blankBit).toBe(false)
    expect(b.options.onEngaged).not.toHaveBeenCalled()
    // C is blank: full flip, but the existing title wins over the fallback.
    expect(c.blankBit).toBe(false)
    expect(c.options.onEngaged).toHaveBeenCalledTimes(1)
  })

  it('re-checks after an in-flight release so a racing running frame is not lost', async () => {
    const h = makeHarness(listWith({ A: true, B: false, C: false }))
    await h.face.sendSession({ sessionId: 'B' }, 'hello B', [], 'queue')
    await h.face.sendSession({ sessionId: 'C' }, 'hello C', [], 'queue')
    // A completes: the release starts (B's prompt in flight, releasing=true).
    h.setList(listWith({ A: false, B: false, C: false }))
    // B's running frame lands while the release is in flight — without the
    // after-inflight re-check the claim would outlive it and wedge the queue.
    h.setList(listWith({ A: false, B: true, C: false }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B'])
    // B completes: C releases immediately (the re-check retired the claim).
    h.setList(listWith({ A: false, B: false, C: false }))
    await flush()
    expect(h.prompts.map(p => p.sessionId)).toEqual(['B', 'C'])
    expect(pendingStore.entries()).toEqual([])
  })

  it('releases when the claim safety valve elapses even if no further frame arrives', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(listWith({ A: true, B: false, C: false }))
      await h.face.sendSession({ sessionId: 'B' }, 'hello B', [], 'queue')
      await h.face.sendSession({ sessionId: 'C' }, 'hello C', [], 'queue')
      h.setList(listWith({ A: false, B: false, C: false }))
      await vi.advanceTimersByTimeAsync(0)
      expect(h.prompts.map(p => p.sessionId)).toEqual(['B'])
      // B's running frame is lost entirely and the host goes quiet: the sweep
      // timer must wake the queue when the claim expires.
      await vi.advanceTimersByTimeAsync(15000 + 1000)
      expect(h.prompts.map(p => p.sessionId)).toEqual(['B', 'C'])
      expect(pendingStore.entries()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-validates a stuck gate against the host list, then releases', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(listWith({ A: true, B: false }))
      // The re-pull converges on host truth: A is no longer running (its
      // running:false status frame was lost client-side).
      h.sessions.refresh.mockImplementation(async () => {
        h.setList(listWith({ A: false, B: false }))
      })
      await h.face.sendSession({ sessionId: 'B' }, 'hello B', [], 'queue')
      expect(pendingStore.entries()).toHaveLength(1)
      // Gate closed by A's flag and the host goes quiet. Before the watchdog
      // cadence nothing re-pulls and nothing releases.
      await vi.advanceTimersByTimeAsync(59_000)
      expect(h.sessions.refresh).not.toHaveBeenCalled()
      expect(h.prompts).toEqual([])
      // At 60 s the watchdog re-pulls the host list; the corrected snapshot
      // releases B.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.sessions.refresh).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.prompts.map(p => p.sessionId)).toEqual(['B'])
      expect(pendingStore.entries()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a failed release queued with backoff instead of dropping it', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(listWith({ A: true, B: false }))
      const face = h.sessionFaces.get('B')
      if (face === undefined) throw new Error('no face for B')
      face.prompt = vi.fn(async () => ({ ok: false, error: { code: 'agent-busy', message: 'prompt rejected', details: {} } }))
      await h.face.sendSession({ sessionId: 'B' }, 'hello B', [], 'queue')
      expect(pendingStore.entries()).toHaveLength(1)
      // A completes: the release fails (host rejects — the failing double
      // records nothing in h.prompts).
      h.setList(listWith({ A: false, B: false }))
      await vi.advanceTimersByTimeAsync(0)
      expect(h.prompts).toEqual([])
      // The message is NOT dropped — it waits out the 2 s backoff with its
      // attempt count carried, then retries (attempt 2 succeeds once the
      // host recovers).
      expect(pendingStore.entries().map(e => [e.sessionId, e.attempts])).toEqual([['B', 1]])
      face.prompt = vi.fn(async () => {
        h.prompts.push({ sessionId: 'B', content: [{ type: 'text', text: 'hello B' }], mode: 'queue' })
        return { ok: true, value: { accepted: true } }
      })
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.prompts.map(p => p.sessionId)).toEqual(['B'])
      expect(pendingStore.entries()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
